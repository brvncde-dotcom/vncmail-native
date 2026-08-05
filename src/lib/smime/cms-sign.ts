/**
 * CMS SignedData construction (RFC 5652 §5).
 *
 * node-forge's own `forge.pkcs7` is not used: its SignedData cannot be verified
 * (`PKCS#7 signature verification not yet implemented`) and it offers no control
 * over signed attributes, so the CMS layer is assembled here directly on forge's
 * ASN.1, RSA and digest primitives.
 */
import { forge } from './forge';
import type { ForgePrivateKey } from './forge';
import {
  algorithmIdentifier, algorithmIdentifierNoParams, bytesToBinary, binaryToBytes,
  ctx, digestBytes, encodeDer, integerFromNumber, octetString, oid,
  rawDer, seq, setOf, utcTime,
} from './der';
import type { CertificateInfo } from './certificate';
import {
  OID_ATTR_CONTENT_TYPE, OID_ATTR_MESSAGE_DIGEST, OID_ATTR_SIGNING_TIME, OID_BY_DIGEST,
  OID_DATA, OID_RSA_ENCRYPTION, OID_SIGNED_DATA, SIGNING_DIGEST, type DigestName,
} from './oids';

export interface SignInput {
  /** The exact bytes to be signed (already CRLF-canonical MIME). */
  content: Uint8Array;
  privateKey: ForgePrivateKey;
  signerCertificate: CertificateInfo;
  /** Intermediates to include so the recipient can build a chain. */
  chain?: CertificateInfo[];
  /**
   * true  → detached signature for `multipart/signed` (eContent omitted)
   * false → opaque signature for `application/pkcs7-mime` (eContent embedded)
   */
  detached: boolean;
  digest?: DigestName;
  signingTime?: Date;
}

/** DER-encoded `ContentInfo { signedData }`. */
export function buildSignedData(input: SignInput): Uint8Array {
  const digest = input.digest ?? SIGNING_DIGEST;
  const messageDigest = digestBytes(digest, input.content);

  // ── signedAttrs ──────────────────────────────────────────────────────
  // Present (and therefore covered by the signature) so the digest, the content
  // type and the claimed signing time cannot be swapped independently.
  const attributes = [
    seq([oid(OID_ATTR_CONTENT_TYPE), setOf([oid(OID_DATA)])]),
    seq([oid(OID_ATTR_SIGNING_TIME), setOf([utcTime(input.signingTime ?? new Date())])]),
    seq([oid(OID_ATTR_MESSAGE_DIGEST), setOf([octetString(messageDigest)])]),
  ];

  // The signature is computed over the attributes encoded as a universal SET,
  // while the structure carries them under an implicit [0] tag (RFC 5652 §5.4).
  const signedAttrsForSigning = encodeDer(setOf(attributes));
  const signedAttrsInStructure = ctx(0, sortedAttributeNodes(attributes));

  const md = forge.md[digest].create();
  md.update(bytesToBinary(signedAttrsForSigning), 'raw');
  const signature = binaryToBytes(input.privateKey.sign(md));

  const certificates = [input.signerCertificate, ...(input.chain ?? [])];

  const signerInfo = seq([
    integerFromNumber(1), // version, because sid is IssuerAndSerialNumber
    seq([rawDer(input.signerCertificate.issuerDer), rawDer(input.signerCertificate.serialDer)]),
    algorithmIdentifierNoParams(OID_BY_DIGEST[digest]),
    signedAttrsInStructure,
    // RFC 5754 §3.2: rsaEncryption with NULL parameters for RSA PKCS#1 v1.5.
    algorithmIdentifier(OID_RSA_ENCRYPTION),
    octetString(signature),
  ]);

  const encapContent = input.detached
    ? seq([oid(OID_DATA)])
    : seq([oid(OID_DATA), ctx(0, [octetString(input.content)])]);

  const signedData = seq([
    integerFromNumber(1),
    setOf([algorithmIdentifierNoParams(OID_BY_DIGEST[digest])]),
    encapContent,
    ctx(0, certificates.map((c) => rawDer(c.der))),
    setOf([signerInfo]),
  ]);

  return encodeDer(seq([oid(OID_SIGNED_DATA), ctx(0, [signedData])]));
}

/**
 * Same ordering `setOf` applies, so the [0]-tagged copy in the structure is
 * byte-identical (modulo the tag) to the copy that was signed.
 */
function sortedAttributeNodes(nodes: ReturnType<typeof seq>[]): ReturnType<typeof seq>[] {
  return [...nodes].sort((a, b) => {
    const ab = forge.asn1.toDer(a).getBytes();
    const bb = forge.asn1.toDer(b).getBytes();
    return ab < bb ? -1 : ab > bb ? 1 : 0;
  });
}
