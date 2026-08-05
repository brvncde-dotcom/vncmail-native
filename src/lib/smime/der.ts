/**
 * A byte-offset-preserving DER/BER reader, plus small builders.
 *
 * Why not just use `forge.asn1.fromDer` for reading: CMS verification has to
 * hash and RSA-verify the *exact original bytes* of the `signedAttrs` element.
 * Re-encoding a parsed tree (which is all forge offers) can legitimately
 * produce different bytes — a sender may emit an unsorted `SET OF`, a BER
 * indefinite length, or a segmented OCTET STRING — and every one of those would
 * turn a valid signature into a spurious "invalid signature" warning. So reads
 * go through this walker, which hands back subranges of the source buffer, and
 * forge.asn1 is used only for *building* structures we emit ourselves.
 *
 * BER tolerance is not optional here: Outlook and several gateways emit
 * indefinite-length SignedData with segmented OCTET STRING content.
 */
import { forge } from './forge';

// Bounded parsing (mirrors the webmail plugin's audit finding 5). A hostile CMS
// blob must not be able to drive unbounded recursion or allocation.
const MAX_DEPTH = 24;
const MAX_NODES = 4096;

export const TAG_CLASS_UNIVERSAL = 0x00;
export const TAG_CLASS_CONTEXT = 0x80;

export const TAG_INTEGER = 0x02;
export const TAG_BIT_STRING = 0x03;
export const TAG_OCTET_STRING = 0x04;
export const TAG_NULL = 0x05;
export const TAG_OID = 0x06;
export const TAG_UTF8_STRING = 0x0c;
export const TAG_SEQUENCE = 0x10;
export const TAG_SET = 0x11;
export const TAG_UTC_TIME = 0x17;
export const TAG_GENERALIZED_TIME = 0x18;

export interface DerNode {
  /** 0x00 universal, 0x40 application, 0x80 context-specific, 0xC0 private. */
  tagClass: number;
  tagNumber: number;
  constructed: boolean;
  /** Offset of the identifier octet. */
  start: number;
  /** Offset of the first content octet. */
  contentStart: number;
  /** Content length in bytes (for indefinite length, the span before the EOC). */
  contentLength: number;
  /** Offset just past the whole TLV (past the EOC for indefinite length). */
  end: number;
  indefinite: boolean;
}

export class DerParseError extends Error {
  constructor(message: string) {
    super(`Malformed CMS/DER data: ${message}`);
    this.name = 'DerParseError';
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DerParseError(message);
}

interface Budget { nodes: number }

function readNodeAt(buf: Uint8Array, offset: number, depth: number, budget: Budget): DerNode {
  assert(depth <= MAX_DEPTH, 'nesting too deep');
  budget.nodes += 1;
  assert(budget.nodes <= MAX_NODES, 'too many ASN.1 elements');
  assert(offset + 1 < buf.length + 1 && offset < buf.length, 'truncated at tag');

  const first = buf[offset];
  const tagClass = first & 0xc0;
  const constructed = (first & 0x20) !== 0;
  let tagNumber = first & 0x1f;
  let cursor = offset + 1;

  if (tagNumber === 0x1f) {
    // High-tag-number form. Not used by CMS, but parse it rather than
    // misinterpreting the following bytes as a length.
    tagNumber = 0;
    for (;;) {
      assert(cursor < buf.length, 'truncated in multi-byte tag');
      const b = buf[cursor++];
      tagNumber = (tagNumber << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
      assert(tagNumber < 0x10000000, 'tag number too large');
    }
  }

  assert(cursor < buf.length, 'truncated at length');
  const lengthByte = buf[cursor++];
  let contentLength: number;
  let indefinite = false;

  if (lengthByte === 0x80) {
    // BER indefinite length: content runs until an end-of-contents marker.
    assert(constructed, 'indefinite length on a primitive element');
    indefinite = true;
    contentLength = 0; // resolved below
  } else if ((lengthByte & 0x80) === 0) {
    contentLength = lengthByte;
  } else {
    const numBytes = lengthByte & 0x7f;
    assert(numBytes > 0 && numBytes <= 4, `unsupported length-of-length (${numBytes})`);
    assert(cursor + numBytes <= buf.length, 'truncated in long-form length');
    contentLength = 0;
    for (let i = 0; i < numBytes; i++) contentLength = contentLength * 256 + buf[cursor++];
  }

  const contentStart = cursor;

  if (!indefinite) {
    assert(contentStart + contentLength <= buf.length, 'element runs past end of buffer');
    return {
      tagClass, tagNumber, constructed, start: offset, contentStart, contentLength,
      end: contentStart + contentLength, indefinite: false,
    };
  }

  // Walk children to locate the end-of-contents (00 00).
  let scan = contentStart;
  for (;;) {
    assert(scan + 1 < buf.length, 'unterminated indefinite-length element');
    if (buf[scan] === 0x00 && buf[scan + 1] === 0x00) {
      return {
        tagClass, tagNumber, constructed, start: offset, contentStart,
        contentLength: scan - contentStart, end: scan + 2, indefinite: true,
      };
    }
    scan = readNodeAt(buf, scan, depth + 1, budget).end;
  }
}

/** Parse the TLV starting at `offset` (default 0). */
export function readNode(buf: Uint8Array, offset = 0): DerNode {
  return readNodeAt(buf, offset, 0, { nodes: 0 });
}

/** Immediate children of a constructed node. */
export function children(buf: Uint8Array, node: DerNode): DerNode[] {
  if (!node.constructed) return [];
  const out: DerNode[] = [];
  const budget: Budget = { nodes: 0 };
  const limit = node.contentStart + node.contentLength;
  let cursor = node.contentStart;
  while (cursor < limit) {
    if (buf[cursor] === 0x00 && cursor + 1 < limit && buf[cursor + 1] === 0x00) break;
    const child = readNodeAt(buf, cursor, 1, budget);
    out.push(child);
    cursor = child.end;
  }
  return out;
}

/** The whole TLV, identifier octet through final content octet. */
export function rawBytes(buf: Uint8Array, node: DerNode): Uint8Array {
  return buf.subarray(node.start, node.end);
}

/** Content octets only. */
export function contentBytes(buf: Uint8Array, node: DerNode): Uint8Array {
  return buf.subarray(node.contentStart, node.contentStart + node.contentLength);
}

export function isSequence(node: DerNode): boolean {
  return node.tagClass === TAG_CLASS_UNIVERSAL && node.tagNumber === TAG_SEQUENCE;
}

export function isSet(node: DerNode): boolean {
  return node.tagClass === TAG_CLASS_UNIVERSAL && node.tagNumber === TAG_SET;
}

export function isContext(node: DerNode, tagNumber: number): boolean {
  return node.tagClass === TAG_CLASS_CONTEXT && node.tagNumber === tagNumber;
}

/**
 * OCTET STRING value, concatenating the segments of a constructed (BER)
 * OCTET STRING. Some senders chunk large CMS content this way.
 */
export function octetStringValue(buf: Uint8Array, node: DerNode): Uint8Array {
  if (!node.constructed) return contentBytes(buf, node);
  const parts: Uint8Array[] = [];
  for (const child of children(buf, node)) parts.push(octetStringValue(buf, child));
  return concatBytes(parts);
}

/** Dotted-decimal OID from an OBJECT IDENTIFIER node's content. */
export function readOid(buf: Uint8Array, node: DerNode): string {
  const bytes = contentBytes(buf, node);
  if (bytes.length === 0) return '';
  const parts: number[] = [];
  const first = bytes[0];
  parts.push(Math.floor(first / 40), first % 40);
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = value * 128 + (bytes[i] & 0x7f);
    if ((bytes[i] & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

/** INTEGER content as lowercase hex, leading zero padding stripped. */
export function readIntegerHex(buf: Uint8Array, node: DerNode): string {
  const bytes = contentBytes(buf, node);
  let hex = bytesToHex(bytes).replace(/^(00)+/, '');
  if (hex === '') hex = '0';
  return hex;
}

/** UTCTime / GeneralizedTime content as an ISO string. */
export function readTime(buf: Uint8Array, node: DerNode): string {
  const raw = new TextDecoder().decode(contentBytes(buf, node)).trim();
  const generalized = node.tagNumber === TAG_GENERALIZED_TIME;
  const m = generalized
    ? raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/)
    : raw.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/);
  if (!m) return '';
  let year = Number(m[1]);
  if (!generalized) year = year >= 50 ? 1900 + year : 2000 + year;
  const iso = Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? '0'));
  return new Date(iso).toISOString();
}

// ── byte helpers ───────────────────────────────────────────────────────

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Uint8Array → forge "binary string" (one byte per char code). */
export function bytesToBinary(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
  }
  return out;
}

/** forge "binary string" → Uint8Array. */
export function binaryToBytes(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  return forge.util.encode64(bytesToBinary(bytes));
}

export function base64ToBytes(b64: string): Uint8Array {
  return binaryToBytes(forge.util.decode64(b64.replace(/\s+/g, '')));
}

// ── builders (forge.asn1 wrappers) ─────────────────────────────────────

type Asn1 = ReturnType<typeof forge.asn1.create>;

export function seq(value: Asn1[]): Asn1 {
  return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, value);
}

/** DER `SET OF`: elements must be sorted by their encodings (X.690 §11.6). */
export function setOf(value: Asn1[]): Asn1 {
  return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, sortDer(value));
}

/** Context-specific constructed tag `[n]`. */
export function ctx(tagNumber: number, value: Asn1[]): Asn1 {
  return forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, tagNumber, true, value);
}

export function oid(dotted: string): Asn1 {
  return forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(dotted).getBytes(),
  );
}

export function octetString(bytes: Uint8Array): Asn1 {
  return forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, bytesToBinary(bytes),
  );
}

export function integerFromNumber(value: number): Asn1 {
  return forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, forge.util.hexToBytes(intToDerHex(value)),
  );
}

/** Re-emit already-encoded DER bytes verbatim inside a structure being built. */
export function rawDer(bytes: Uint8Array): Asn1 {
  return forge.asn1.fromDer(forge.util.createBuffer(bytesToBinary(bytes)));
}

export function nullValue(): Asn1 {
  return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, '');
}

export function utcTime(date: Date): Asn1 {
  return forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.UTCTIME, false, forge.asn1.dateToUtcTime(date),
  );
}

export function algorithmIdentifier(algOid: string, params?: Asn1): Asn1 {
  return seq(params ? [oid(algOid), params] : [oid(algOid), nullValue()]);
}

/** AlgorithmIdentifier with an absent (not NULL) parameters field. */
export function algorithmIdentifierNoParams(algOid: string): Asn1 {
  return seq([oid(algOid)]);
}

export function encodeDer(node: Asn1): Uint8Array {
  return binaryToBytes(forge.asn1.toDer(node).getBytes());
}

function sortDer(nodes: Asn1[]): Asn1[] {
  return [...nodes].sort((a, b) => {
    const ab = forge.asn1.toDer(a).getBytes();
    const bb = forge.asn1.toDer(b).getBytes();
    return ab < bb ? -1 : ab > bb ? 1 : 0;
  });
}

function intToDerHex(value: number): string {
  if (value === 0) return '00';
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  // A leading byte >= 0x80 would read as negative; prepend a zero byte.
  if (parseInt(hex.slice(0, 2), 16) >= 0x80) hex = `00${hex}`;
  return hex;
}

/** Re-tag a `[n] IMPLICIT` element's bytes as a universal `SET` (CMS §5.4). */
export function retagAsSet(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  out[0] = 0x31; // constructed SET
  return out;
}

export function digestBytes(name: 'sha1' | 'sha256' | 'sha384' | 'sha512', bytes: Uint8Array): Uint8Array {
  const md = forge.md[name].create();
  md.update(bytesToBinary(bytes), 'raw');
  return binaryToBytes(md.digest().getBytes());
}
