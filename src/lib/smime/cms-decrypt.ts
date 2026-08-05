/**
 * CMS EnvelopedData decryption (RFC 5652 §6).
 *
 * ── EFAIL / unauthenticated CBC (audited webmail finding 2) ────────────
 * Two independent guards, in this order:
 *
 * 1. `resolveContentEncryption` (see oids.ts) is called *before any private key
 *    is touched*. A message asking to be decrypted under DES, 3DES or RC2 is
 *    refused outright — the primitive is never invoked, so there is nothing for
 *    a downgrade to reach.
 *
 * 2. The result carries `contentAuthenticated`, true only for AEAD. AES-CBC
 *    stays supported (RFC 5751 makes AES-128-CBC mandatory and Outlook /
 *    Thunderbird default to it, so refusing it would break most real encrypted
 *    mail) but the flag travels with the plaintext all the way to the renderer,
 *    which then refuses to render it as live HTML. That — not "decrypt only
 *    AEAD" — is the mitigation: unauthenticated plaintext is never turned into a
 *    document that can make requests.
 *
 * RFC 5083 AuthEnvelopedData is recognised and rejected with a specific message
 * rather than being misparsed as EnvelopedData.
 */
import { forge } from './forge';
import type { ForgePrivateKey } from './forge';
import {
  binaryToBytes, bytesEqual, bytesToBinary, bytesToHex, children, contentBytes, isContext,
  isSequence, isSet, octetStringValue, rawBytes, readIntegerHex, readNode, readOid,
  TAG_CLASS_UNIVERSAL, TAG_OCTET_STRING, TAG_OID, type DerNode,
} from './der';
import type { CertificateInfo } from './certificate';
import {
  OID_AUTH_ENVELOPED_DATA, OID_ENVELOPED_DATA, OID_RSAES_OAEP, resolveContentEncryption,
  type ContentEncryptionAlgorithm,
} from './oids';

export class SmimeKeyLockedError extends Error {
  keyId: string;
  constructor(keyId: string) {
    super('This message is encrypted to a locked certificate. Unlock it to read the message.');
    this.name = 'SmimeKeyLockedError';
    this.keyId = keyId;
  }
}

export class SmimeNoKeyError extends Error {
  constructor() {
    super('No imported S/MIME certificate matches any recipient of this encrypted message.');
    this.name = 'SmimeNoKeyError';
  }
}

export class SmimeDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmimeDecryptError';
  }
}

export interface DecryptResult {
  content: Uint8Array;
  /** Id of the key record that decrypted it. */
  keyId: string;
  /** True only for AEAD content encryption. Drives HTML suppression. */
  contentAuthenticated: boolean;
  contentAlgorithm: string;
  /** True when the key was unwrapped with legacy RSAES-PKCS1-v1_5. */
  legacyKeyTransport: boolean;
}

/** A private key available for decryption. */
export interface UnlockedKey {
  id: string;
  certificate: CertificateInfo;
  privateKey: ForgePrivateKey;
}

/** A key record we know about but that is currently locked. */
export interface LockedKeyRef {
  id: string;
  certificate: CertificateInfo;
}

interface RecipientInfoParsed {
  index: number;
  issuerDer?: Uint8Array;
  serialHex?: string;
  ski?: string;
  keyTransportOid: string;
  encryptedKey: Uint8Array;
}

interface EnvelopedParts {
  recipients: RecipientInfoParsed[];
  contentEncryptionOid: string;
  algorithmParams?: DerNode;
  buf: Uint8Array;
  encryptedContent: Uint8Array;
}

function parseEnvelopedData(cmsDer: Uint8Array): EnvelopedParts {
  const contentInfo = readNode(cmsDer);
  const ci = children(cmsDer, contentInfo);
  if (ci.length < 2) throw new SmimeDecryptError('Malformed encrypted message');
  const contentType = readOid(cmsDer, ci[0]);
  if (contentType === OID_AUTH_ENVELOPED_DATA) {
    throw new SmimeDecryptError(
      'This message uses CMS AuthEnvelopedData, which is not supported yet.',
    );
  }
  if (contentType !== OID_ENVELOPED_DATA) {
    throw new SmimeDecryptError(`Unexpected CMS content type: ${contentType}`);
  }

  const envelopedData = children(cmsDer, ci[1])[0];
  if (!envelopedData) throw new SmimeDecryptError('EnvelopedData is missing');
  const fields = children(cmsDer, envelopedData);

  // version, [0] originatorInfo?, recipientInfos, encryptedContentInfo, ...
  const recipientSet = fields.find(isSet);
  if (!recipientSet) throw new SmimeDecryptError('EnvelopedData has no recipients');
  const eci = fields.slice(1).filter(isSequence).pop();
  if (!eci) throw new SmimeDecryptError('EnvelopedData has no encrypted content');

  const eciFields = children(cmsDer, eci);
  const algNode = eciFields[1];
  const algChildren = algNode ? children(cmsDer, algNode) : [];
  const algOidNode = algChildren.find(
    (n) => n.tagClass === TAG_CLASS_UNIVERSAL && n.tagNumber === TAG_OID,
  );
  const encryptedContentNode = eciFields.find((n) => isContext(n, 0));
  if (!encryptedContentNode) throw new SmimeDecryptError('Encrypted content is empty');

  const recipients: RecipientInfoParsed[] = [];
  const recipientNodes = children(cmsDer, recipientSet);
  for (let i = 0; i < recipientNodes.length; i++) {
    const node = recipientNodes[i];
    // Only KeyTransRecipientInfo (a bare SEQUENCE) is supported. KeyAgree
    // ([1]), KEK ([2]) and password ([3]) recipients are skipped rather than
    // guessed at.
    if (!isSequence(node)) continue;
    const parsed = parseKeyTransRecipient(cmsDer, node, i);
    if (parsed) recipients.push(parsed);
  }

  return {
    recipients,
    contentEncryptionOid: algOidNode ? readOid(cmsDer, algOidNode) : '',
    algorithmParams: algChildren.find((n) => n !== algOidNode),
    buf: cmsDer,
    encryptedContent: encryptedContentNode.constructed
      ? octetStringValue(cmsDer, encryptedContentNode)
      : contentBytes(cmsDer, encryptedContentNode),
  };
}

function parseKeyTransRecipient(
  buf: Uint8Array,
  node: DerNode,
  index: number,
): RecipientInfoParsed | null {
  const fields = children(buf, node);
  if (fields.length < 4) return null;
  const rid = fields[1];

  let issuerDer: Uint8Array | undefined;
  let serialHex: string | undefined;
  let ski: string | undefined;
  if (isSequence(rid)) {
    const parts = children(buf, rid);
    if (parts.length >= 2) {
      issuerDer = rawBytes(buf, parts[0]);
      serialHex = readIntegerHex(buf, parts[1]);
    }
  } else if (isContext(rid, 0)) {
    ski = bytesToHex(contentBytes(buf, rid));
  } else {
    return null;
  }

  const algOidNode = children(buf, fields[2]).find(
    (n) => n.tagClass === TAG_CLASS_UNIVERSAL && n.tagNumber === TAG_OID,
  );
  const keyNode = fields[3];
  if (!algOidNode || keyNode.tagNumber !== TAG_OCTET_STRING) return null;

  return {
    index,
    issuerDer,
    serialHex,
    ski,
    keyTransportOid: readOid(buf, algOidNode),
    encryptedKey: octetStringValue(buf, keyNode),
  };
}

function matches(recipient: RecipientInfoParsed, cert: CertificateInfo): boolean {
  if (recipient.issuerDer && recipient.serialHex) {
    return recipient.serialHex === cert.serialHex && bytesEqual(recipient.issuerDer, cert.issuerDer);
  }
  if (recipient.ski && cert.ski) return recipient.ski === cert.ski;
  return false;
}

/**
 * Which of our key records this message is addressed to. Used to decide whether
 * to prompt for an unlock, without decrypting anything.
 */
export function decryptionCandidates(
  cmsDer: Uint8Array,
  keys: LockedKeyRef[],
): string[] {
  try {
    const parts = parseEnvelopedData(cmsDer);
    const out: string[] = [];
    for (const recipient of parts.recipients) {
      for (const key of keys) {
        if (matches(recipient, key.certificate) && !out.includes(key.id)) out.push(key.id);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Read the content-encryption IV. Accepts both shapes seen in the wild:
 *   • a bare OCTET STRING (what pkijs / the VNCmail+ webmail plugin emit, and
 *     the standard encoding for AES-CBC)
 *   • RFC 5084 `GCMParameters ::= SEQUENCE { aes-nonce OCTET STRING,
 *     aes-ICVlen INTEGER DEFAULT 12 }`
 */
function readIv(parts: EnvelopedParts): { iv: Uint8Array; tagLength: number } {
  const node = parts.algorithmParams;
  if (!node) throw new SmimeDecryptError('Encrypted message has no content-encryption IV');
  if (node.tagNumber === TAG_OCTET_STRING && !node.constructed) {
    return { iv: contentBytes(parts.buf, node), tagLength: 16 };
  }
  if (isSequence(node)) {
    const inner = children(parts.buf, node);
    const nonceNode = inner.find((n) => n.tagNumber === TAG_OCTET_STRING);
    if (!nonceNode) throw new SmimeDecryptError('Encrypted message has no content-encryption IV');
    const icvNode = inner.find((n) => n.tagNumber === 0x02);
    const icv = icvNode ? parseInt(readIntegerHex(parts.buf, icvNode), 16) : 12;
    return { iv: contentBytes(parts.buf, nonceNode), tagLength: icv };
  }
  throw new SmimeDecryptError('Unsupported content-encryption parameters');
}

function unwrapCek(
  recipient: RecipientInfoParsed,
  privateKey: ForgePrivateKey,
): { cek: Uint8Array; legacy: boolean } {
  const wrapped = bytesToBinary(recipient.encryptedKey);
  if (recipient.keyTransportOid === OID_RSAES_OAEP) {
    return {
      cek: binaryToBytes(privateKey.decrypt(wrapped, 'RSA-OAEP', {
        md: forge.md.sha256.create(),
        mgf1: { md: forge.md.sha256.create() },
      })),
      legacy: false,
    };
  }
  // rsaEncryption → RSAES-PKCS1-v1_5. Still what Outlook and older
  // Thunderbird emit, so it stays supported for reading; we never emit it.
  return {
    cek: binaryToBytes(privateKey.decrypt(wrapped, 'RSAES-PKCS1-V1_5')),
    legacy: true,
  };
}

function decryptContent(
  parts: EnvelopedParts,
  alg: ContentEncryptionAlgorithm,
  cek: Uint8Array,
): Uint8Array {
  if (cek.length !== alg.keyLength) {
    throw new SmimeDecryptError('Recovered content-encryption key has the wrong length');
  }
  const { iv, tagLength } = readIv(parts);

  if (alg.cipher === 'AES-GCM') {
    const tagBytes = tagLength <= 16 ? tagLength : 16;
    if (parts.encryptedContent.length < tagBytes) {
      throw new SmimeDecryptError('Encrypted content is too short to contain an authentication tag');
    }
    const split = parts.encryptedContent.length - tagBytes;
    const decipher = forge.cipher.createDecipher('AES-GCM', bytesToBinary(cek));
    decipher.start({
      iv: bytesToBinary(iv),
      tagLength: tagBytes * 8,
      tag: forge.util.createBuffer(bytesToBinary(parts.encryptedContent.subarray(split))),
    });
    decipher.update(forge.util.createBuffer(bytesToBinary(parts.encryptedContent.subarray(0, split))));
    // A false return here is a failed authentication tag. It must stay a hard
    // failure: returning the plaintext anyway is precisely the EFAIL footgun.
    if (!decipher.finish()) {
      throw new SmimeDecryptError('Authentication tag check failed — the message was modified in transit.');
    }
    return binaryToBytes(decipher.output.getBytes());
  }

  const decipher = forge.cipher.createDecipher('AES-CBC', bytesToBinary(cek));
  decipher.start({ iv: bytesToBinary(iv) });
  decipher.update(forge.util.createBuffer(bytesToBinary(parts.encryptedContent)));
  if (!decipher.finish()) throw new SmimeDecryptError('Decryption failed (bad padding)');
  return binaryToBytes(decipher.output.getBytes());
}

export interface DecryptInput {
  cmsDer: Uint8Array;
  unlocked: UnlockedKey[];
  /** Records that match but are locked, so we can ask for an unlock. */
  locked: LockedKeyRef[];
}

export function decryptEnvelopedData(input: DecryptInput): DecryptResult {
  const parts = parseEnvelopedData(input.cmsDer);

  // GUARD 1: the algorithm allowlist runs before any private key is used.
  const alg = resolveContentEncryption(parts.contentEncryptionOid);

  const attempted: { recipient: RecipientInfoParsed; key: UnlockedKey }[] = [];
  for (const recipient of parts.recipients) {
    for (const key of input.unlocked) {
      if (matches(recipient, key.certificate)) attempted.push({ recipient, key });
    }
  }

  let lastError: Error | undefined;
  for (const { recipient, key } of attempted) {
    try {
      const { cek, legacy } = unwrapCek(recipient, key.privateKey);
      const content = decryptContent(parts, alg, cek);
      return {
        content,
        keyId: key.id,
        // GUARD 2: propagated to the renderer, which suppresses HTML when false.
        contentAuthenticated: alg.authenticated,
        contentAlgorithm: alg.name,
        legacyKeyTransport: legacy,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const lockedMatch = parts.recipients
    .flatMap((r) => input.locked.filter((k) => matches(r, k.certificate)))
    .find((k) => !input.unlocked.some((u) => u.id === k.id));
  if (lockedMatch) throw new SmimeKeyLockedError(lockedMatch.id);

  if (attempted.length === 0) throw new SmimeNoKeyError();
  throw lastError ?? new SmimeDecryptError('Failed to decrypt the message with any available key');
}
