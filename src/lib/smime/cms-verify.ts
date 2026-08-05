/**
 * CMS SignedData verification (RFC 5652 §5).
 *
 * Handles both S/MIME signature forms:
 *   • opaque   — `application/pkcs7-mime; smime-type=signed-data`, content
 *                embedded in eContent
 *   • detached — `multipart/signed`, content supplied by the caller as the
 *                exact raw bytes of the first MIME part
 *
 * The detached form is the common one in the wild (Thunderbird, Outlook,
 * most gateways), which is why the raw-message path in `smime-message.ts` goes
 * to the trouble of recovering the signed part byte-for-byte.
 *
 * Two properties are load-bearing and deliberately fail closed:
 *   • `signatureValid` is false unless the messageDigest attribute matches a
 *     digest we computed ourselves AND the RSA signature over the signedAttrs
 *     verifies. A missing or unparsable piece is a failure, not a pass.
 *   • `signerEmailMatch` is `undefined` when it cannot be decided (no From
 *     header, no addresses in the certificate). Callers must treat `undefined`
 *     as "no match" — see `smime-autoimport.ts`.
 */
import {
  bytesEqual, bytesToBinary, bytesToHex, children, contentBytes, digestBytes, isContext,
  isSequence, isSet, octetStringValue, rawBytes, readIntegerHex, readNode, readOid, readTime,
  retagAsSet, TAG_CLASS_UNIVERSAL, TAG_OCTET_STRING, TAG_OID, TAG_UTC_TIME,
  TAG_GENERALIZED_TIME, type DerNode,
} from './der';
import {
  certAssertsAddress, isCertificateExpired, isCertificateNotYetValid, parseCertificate,
  type CertificateInfo,
} from './certificate';
import {
  DIGEST_BY_OID, digestIsWeak, OID_ATTR_CONTENT_TYPE, OID_ATTR_MESSAGE_DIGEST,
  OID_ATTR_SIGNING_TIME, OID_SIGNED_DATA, type DigestName,
} from './oids';

export interface SignatureStatus {
  signatureValid: boolean;
  signatureError?: string;
  signerCertificate?: CertificateInfo;
  /**
   * Does the signer certificate assert the From address?
   * `undefined` = undecidable. Never treat that as a match.
   */
  signerEmailMatch?: boolean;
  selfSigned?: boolean;
  digestAlgorithm?: DigestName;
  weakDigest?: boolean;
  signingTime?: string;
  certificateExpired?: boolean;
  certificateNotYetValid?: boolean;
  /** More than one SignerInfo; only the first is evaluated. */
  multipleSigners?: boolean;
}

export interface VerifyResult {
  /** Inner MIME bytes. Present for opaque signatures only. */
  content?: Uint8Array;
  status: SignatureStatus;
}

export class CmsStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CmsStructureError';
  }
}

interface SignedDataParts {
  buf: Uint8Array;
  eContentType: string;
  eContent?: Uint8Array;
  certificates: CertificateInfo[];
  signerInfos: DerNode[];
}

function parseSignedData(cmsDer: Uint8Array): SignedDataParts {
  const contentInfo = readNode(cmsDer);
  const ciChildren = children(cmsDer, contentInfo);
  if (ciChildren.length < 2) throw new CmsStructureError('ContentInfo is truncated');
  if (readOid(cmsDer, ciChildren[0]) !== OID_SIGNED_DATA) {
    throw new CmsStructureError(`Unexpected CMS content type: ${readOid(cmsDer, ciChildren[0])}`);
  }
  const explicit = children(cmsDer, ciChildren[1]);
  const signedData = explicit[0];
  if (!signedData) throw new CmsStructureError('SignedData is missing');

  const fields = children(cmsDer, signedData);
  // version, digestAlgorithms, encapContentInfo, [0] certs?, [1] crls?, signerInfos
  if (fields.length < 4) throw new CmsStructureError('SignedData is truncated');

  const encap = fields[2];
  const encapChildren = children(cmsDer, encap);
  const eContentType = encapChildren[0] ? readOid(cmsDer, encapChildren[0]) : '';
  let eContent: Uint8Array | undefined;
  const eContentNode = encapChildren.find((n) => isContext(n, 0));
  if (eContentNode) {
    const inner = children(cmsDer, eContentNode)[0];
    // Normally [0] EXPLICIT wraps an OCTET STRING; tolerate a BER encoder that
    // emitted the content octets directly under the tag.
    eContent = inner ? octetStringValue(cmsDer, inner) : contentBytes(cmsDer, eContentNode);
  }

  const certificates: CertificateInfo[] = [];
  const certsNode = fields.slice(3).find((n) => isContext(n, 0));
  if (certsNode) {
    for (const certNode of children(cmsDer, certsNode)) {
      if (!isSequence(certNode)) continue; // skip attribute certificates
      try {
        certificates.push(parseCertificate(rawBytes(cmsDer, certNode)));
      } catch {
        /* an unparsable bystander certificate must not fail the whole message */
      }
    }
  }

  const signerInfosNode = fields.slice(3).find(isSet);
  if (!signerInfosNode) throw new CmsStructureError('SignedData has no signerInfos');

  return {
    buf: cmsDer,
    eContentType,
    eContent,
    certificates,
    signerInfos: children(cmsDer, signerInfosNode),
  };
}

interface ParsedSignerInfo {
  digest: DigestName;
  /** Raw DER of the [0] signedAttrs element, when present. */
  signedAttrsRaw?: Uint8Array;
  messageDigest?: Uint8Array;
  attrContentType?: string;
  signingTime?: string;
  signature: Uint8Array;
  issuerDer?: Uint8Array;
  serialHex?: string;
  ski?: string;
}

function parseSignerInfo(buf: Uint8Array, node: DerNode): ParsedSignerInfo {
  const fields = children(buf, node);
  if (fields.length < 5) throw new CmsStructureError('SignerInfo is truncated');

  let index = 1; // skip version
  const sid = fields[index++];

  let issuerDer: Uint8Array | undefined;
  let serialHex: string | undefined;
  let ski: string | undefined;
  if (isSequence(sid)) {
    const parts = children(buf, sid);
    if (parts.length >= 2) {
      issuerDer = rawBytes(buf, parts[0]);
      serialHex = readIntegerHex(buf, parts[1]);
    }
  } else if (isContext(sid, 0)) {
    ski = bytesToHex(contentBytes(buf, sid));
  }

  const digestAlgNode = fields[index++];
  const digestOidNode = children(buf, digestAlgNode).find(
    (n) => n.tagClass === TAG_CLASS_UNIVERSAL && n.tagNumber === TAG_OID,
  );
  const digestOid = digestOidNode ? readOid(buf, digestOidNode) : '';
  const digest = DIGEST_BY_OID[digestOid];
  if (!digest) throw new CmsStructureError(`Unsupported signature digest algorithm (${digestOid || 'none'})`);

  let signedAttrsRaw: Uint8Array | undefined;
  let messageDigest: Uint8Array | undefined;
  let attrContentType: string | undefined;
  let signingTime: string | undefined;
  if (fields[index] && isContext(fields[index], 0)) {
    const attrsNode = fields[index++];
    signedAttrsRaw = rawBytes(buf, attrsNode);
    for (const attr of children(buf, attrsNode)) {
      const parts = children(buf, attr);
      if (parts.length < 2) continue;
      const attrOid = readOid(buf, parts[0]);
      const values = children(buf, parts[1]);
      if (!values.length) continue;
      if (attrOid === OID_ATTR_MESSAGE_DIGEST && values[0].tagNumber === TAG_OCTET_STRING) {
        messageDigest = octetStringValue(buf, values[0]);
      } else if (attrOid === OID_ATTR_CONTENT_TYPE) {
        attrContentType = readOid(buf, values[0]);
      } else if (
        attrOid === OID_ATTR_SIGNING_TIME
        && (values[0].tagNumber === TAG_UTC_TIME || values[0].tagNumber === TAG_GENERALIZED_TIME)
      ) {
        signingTime = readTime(buf, values[0]);
      }
    }
  }

  index++; // signatureAlgorithm — the digest comes from digestAlgorithm above
  const signatureNode = fields[index];
  if (!signatureNode) throw new CmsStructureError('SignerInfo has no signature');

  return {
    digest,
    signedAttrsRaw,
    messageDigest,
    attrContentType,
    signingTime,
    signature: octetStringValue(buf, signatureNode),
    issuerDer,
    serialHex,
    ski,
  };
}

function findSignerCertificate(
  certificates: CertificateInfo[],
  signer: ParsedSignerInfo,
): CertificateInfo | undefined {
  if (signer.issuerDer && signer.serialHex) {
    const match = certificates.find(
      (c) => c.serialHex === signer.serialHex && bytesEqual(c.issuerDer, signer.issuerDer!),
    );
    if (match) return match;
  }
  if (signer.ski) {
    const match = certificates.find((c) => c.ski === signer.ski);
    if (match) return match;
  }
  // A bundle carrying exactly one certificate identifies its signer
  // unambiguously; anything else stays unresolved rather than guessed.
  return certificates.length === 1 ? certificates[0] : undefined;
}

export interface VerifyOptions {
  /**
   * For a detached (`multipart/signed`) signature: the exact raw bytes of the
   * signed MIME part, including its own headers and CRLF line endings.
   */
  detachedContent?: Uint8Array;
  /** The message's From address, for the signer-identity check. */
  fromAddress?: string;
  now?: Date;
}

export function verifySignedData(cmsDer: Uint8Array, options: VerifyOptions = {}): VerifyResult {
  const parts = parseSignedData(cmsDer);

  if (parts.signerInfos.length === 0) {
    return { content: parts.eContent, status: { signatureValid: false, signatureError: 'Message carries no signature' } };
  }

  const signer = parseSignerInfo(parts.buf, parts.signerInfos[0]);
  const signedContent = parts.eContent ?? options.detachedContent;
  const status: SignatureStatus = {
    signatureValid: false,
    digestAlgorithm: signer.digest,
    weakDigest: digestIsWeak(signer.digest),
    signingTime: signer.signingTime,
    multipleSigners: parts.signerInfos.length > 1 ? true : undefined,
  };

  const cert = findSignerCertificate(parts.certificates, signer);
  if (cert) {
    status.signerCertificate = cert;
    status.selfSigned = cert.selfSigned;
    status.certificateExpired = isCertificateExpired(cert, options.now);
    status.certificateNotYetValid = isCertificateNotYetValid(cert, options.now);
    if (options.fromAddress && cert.emailAddresses.length > 0) {
      status.signerEmailMatch = certAssertsAddress(cert.emailAddresses, options.fromAddress);
    }
  } else {
    status.signatureError = 'Signer certificate not found in the message';
    return { content: parts.eContent, status };
  }

  if (!signedContent) {
    status.signatureError = 'Signed content is not available (detached signature with no matching part)';
    return { content: parts.eContent, status };
  }
  if (!cert.publicKey) {
    status.signatureError = `Unsupported signer key type (${cert.publicKeyAlgorithm})`;
    return { content: parts.eContent, status };
  }

  try {
    const computed = digestBytes(signer.digest, signedContent);
    let toVerify: Uint8Array;

    if (signer.signedAttrsRaw) {
      // With signed attributes the signature covers the attributes, and the
      // attributes must in turn commit to the content digest. Both links are
      // checked; skipping the first would let an attacker attach any signature
      // to any content.
      if (!signer.messageDigest || !bytesEqual(signer.messageDigest, computed)) {
        status.signatureError = 'Content does not match the signed message digest';
        return { content: parts.eContent, status };
      }
      if (signer.attrContentType && signer.attrContentType !== parts.eContentType) {
        status.signatureError = 'Signed content type does not match the message';
        return { content: parts.eContent, status };
      }
      toVerify = digestBytes(signer.digest, retagAsSet(signer.signedAttrsRaw));
    } else {
      toVerify = computed;
    }

    const valid = cert.publicKey.verify(bytesToBinary(toVerify), bytesToBinary(signer.signature));
    status.signatureValid = valid && !status.certificateExpired && !status.certificateNotYetValid;
    if (!valid) {
      status.signatureError = 'Signature does not verify against the signer certificate';
    } else if (status.certificateExpired) {
      status.signatureError = 'Signer certificate has expired';
    } else if (status.certificateNotYetValid) {
      status.signatureError = 'Signer certificate is not yet valid';
    }
  } catch (err) {
    status.signatureValid = false;
    status.signatureError = err instanceof Error ? err.message : 'Signature verification failed';
  }

  return { content: parts.eContent, status };
}

/** Recover the certificates carried by a SignedData without verifying it. */
export function signedDataCertificates(cmsDer: Uint8Array): CertificateInfo[] {
  return parseSignedData(cmsDer).certificates;
}
