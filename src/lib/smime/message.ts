/**
 * Turn a raw RFC 822 message into a rendered S/MIME result.
 *
 * Pure: no network, no storage. The caller fetches the raw blob and supplies the
 * unlocked keys, which keeps the whole crypto pipeline unit-testable.
 *
 * Layers are peeled in a bounded loop so the common real-world nestings all
 * work — opaque signed, detached signed, encrypted, and encrypted-then-signed
 * (sign-then-encrypt, which is what every sane client produces).
 */
import { binaryToBytes, bytesToUtf8, readNode, readOid, children } from './der';
import { forge } from './forge';
import {
  decryptEnvelopedData, SmimeKeyLockedError, type LockedKeyRef, type UnlockedKey,
} from './cms-decrypt';
import { verifySignedData, type SignatureStatus } from './cms-verify';
import { flattenMime, parseMime, type FlattenedMime, type MimePart } from './mime-parse';
import { OID_ENVELOPED_DATA, OID_SIGNED_DATA } from './oids';

const MAX_LAYERS = 4;

export interface SmimeResult {
  isSigned: boolean;
  isEncrypted: boolean;
  signature?: SignatureStatus;
  /** Name of the content-encryption algorithm, for the banner. */
  contentAlgorithm?: string;
  /** True when the *cipher* authenticated the plaintext (AEAD). */
  cipherAuthenticated?: boolean;
  /**
   * True when the plaintext's integrity is assured — by an AEAD cipher, or by a
   * valid signature made inside the encryption layer.
   */
  contentAuthenticated: boolean;
  /**
   * EFAIL guard. When true the caller must render the body as plain text and
   * must not load remote content: nothing vouches for these bytes not having
   * been altered in transit.
   */
  suppressHtml: boolean;
  html?: string;
  text?: string;
  attachments: FlattenedMime['attachments'];
  /** Present when processing could not complete. */
  error?: string;
  /** Set when decryption needs a key the user has not unlocked. */
  lockedKeyId?: string;
}

export interface ProcessOptions {
  raw: Uint8Array;
  fromAddress?: string;
  unlockedKeys: UnlockedKey[];
  lockedKeys: LockedKeyRef[];
  now?: Date;
}

const PKCS7_MIME = new Set(['application/pkcs7-mime', 'application/x-pkcs7-mime']);
const PKCS7_SIGNATURE = new Set(['application/pkcs7-signature', 'application/x-pkcs7-signature']);

/**
 * Coerce a part body into DER. A well-formed message hands us DER already
 * (base64 was undone by the MIME decoder); a sloppy sender may leave the base64
 * in place with no Content-Transfer-Encoding header.
 */
function normalizeCms(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0 && bytes[0] === 0x30) return bytes;
  const text = bytesToUtf8(bytes)
    .replace(/-----(BEGIN|END)[A-Z0-9 ]+-----/g, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  if (text.length < 8) return bytes;
  try {
    const decoded = binaryToBytes(forge.util.decode64(text));
    if (decoded.length > 0 && decoded[0] === 0x30) return decoded;
  } catch {
    /* not base64 */
  }
  return bytes;
}

function cmsContentType(der: Uint8Array): string | undefined {
  try {
    const node = readNode(der);
    const first = children(der, node)[0];
    return first ? readOid(der, first) : undefined;
  } catch {
    return undefined;
  }
}

/** Find the CMS part in a `multipart/signed`, plus the part it covers. */
function findDetachedSignature(part: MimePart): { content: MimePart; cms: Uint8Array } | undefined {
  if (!part.contentType.startsWith('multipart/signed')) return undefined;
  const signature = part.children.find((c) => PKCS7_SIGNATURE.has(c.contentType));
  const content = part.children.find((c) => c !== signature);
  if (!signature || !content) return undefined;
  return { content, cms: normalizeCms(signature.bytes) };
}

function findOpaqueCms(part: MimePart): Uint8Array | undefined {
  if (PKCS7_MIME.has(part.contentType)) return normalizeCms(part.bytes);
  // An opaque CMS sometimes arrives as a lone application/octet-stream named
  // smime.p7m; accept that when the bytes really do parse as CMS.
  if (part.filename?.toLowerCase() === 'smime.p7m') {
    const der = normalizeCms(part.bytes);
    const type = cmsContentType(der);
    if (type === OID_SIGNED_DATA || type === OID_ENVELOPED_DATA) return der;
  }
  return undefined;
}

export function processSmimeMessage(options: ProcessOptions): SmimeResult {
  const result: SmimeResult = {
    isSigned: false,
    isEncrypted: false,
    contentAuthenticated: false,
    suppressHtml: false,
    attachments: [],
  };

  let entity: MimePart;
  try {
    entity = parseMime(options.raw);
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'Could not parse the message';
    return result;
  }

  for (let layer = 0; layer < MAX_LAYERS; layer++) {
    // A multipart/alternative or /mixed can wrap the S/MIME part; descend into a
    // single-child container rather than giving up.
    const target = locateSmimePart(entity);
    if (!target) break;
    entity = target;

    const detached = findDetachedSignature(entity);
    if (detached) {
      const verified = verifySignedData(detached.cms, {
        detachedContent: detached.content.raw,
        fromAddress: options.fromAddress,
        now: options.now,
      });
      result.isSigned = true;
      result.signature = verified.status;
      entity = detached.content;
      continue;
    }

    const cms = findOpaqueCms(entity);
    if (!cms) break;

    const contentType = cmsContentType(cms);

    if (contentType === OID_SIGNED_DATA) {
      const verified = verifySignedData(cms, {
        fromAddress: options.fromAddress,
        now: options.now,
      });
      result.isSigned = true;
      result.signature = verified.status;
      if (!verified.content) {
        result.error = verified.status.signatureError
          ?? 'The signed message contains no readable content.';
        break;
      }
      entity = parseMime(verified.content);
      continue;
    }

    if (contentType === OID_ENVELOPED_DATA) {
      result.isEncrypted = true;
      try {
        const decrypted = decryptEnvelopedData({
          cmsDer: cms,
          unlocked: options.unlockedKeys,
          locked: options.lockedKeys,
        });
        result.cipherAuthenticated = decrypted.contentAuthenticated;
        result.contentAlgorithm = decrypted.contentAlgorithm;
        entity = parseMime(decrypted.content);
        continue;
      } catch (err) {
        if (err instanceof SmimeKeyLockedError) result.lockedKeyId = err.keyId;
        result.error = err instanceof Error ? err.message : 'Could not decrypt the message';
        break;
      }
    }

    result.error = `Unsupported CMS content type (${contentType ?? 'unknown'})`;
    break;
  }

  // Integrity: an AEAD cipher, or a signature made *inside* the encryption layer
  // (sign-then-encrypt), both rule out the ciphertext-malleability attack.
  result.contentAuthenticated = result.isEncrypted
    ? (result.cipherAuthenticated === true || result.signature?.signatureValid === true)
    : true;
  result.suppressHtml = result.isEncrypted && !result.contentAuthenticated;

  if (!result.error) {
    const flat = flattenMime(entity);
    result.html = flat.html;
    result.text = flat.text;
    result.attachments = flat.attachments;
  }

  return result;
}

/**
 * Descend through plain MIME containers to the S/MIME part, if there is one.
 * Returns the entity to process, or undefined when this layer holds no CMS.
 */
function locateSmimePart(entity: MimePart): MimePart | undefined {
  const queue: { part: MimePart; depth: number }[] = [{ part: entity, depth: 0 }];
  while (queue.length > 0) {
    const { part, depth } = queue.shift()!;
    if (depth > 6) continue;
    if (part.contentType.startsWith('multipart/signed') && findDetachedSignature(part)) return part;
    if (findOpaqueCms(part)) return part;
    for (const child of part.children) queue.push({ part: child, depth: depth + 1 });
  }
  return undefined;
}
