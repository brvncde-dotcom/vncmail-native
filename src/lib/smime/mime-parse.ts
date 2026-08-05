/**
 * A small, bounded MIME parser for content recovered from CMS.
 *
 * Once a message is decrypted or verified, its inner MIME comes from the
 * network and has never been through the server's parser — so this walker is
 * hard-capped on depth, part count and total bytes (mirroring the webmail
 * plugin's audit finding 5). Past the caps a multipart is treated as a leaf
 * rather than recursed into; nothing throws, because a truncated render beats
 * an unbounded one.
 */
import { binaryToBytes, bytesToBinary, bytesToUtf8, concatBytes } from './der';
import { forge } from './forge';

const MAX_DEPTH = 20;
const MAX_PARTS = 200;
const MAX_BYTES = 20 * 1024 * 1024;

export interface MimePart {
  contentType: string;
  charset?: string;
  disposition?: string;
  filename?: string;
  cid?: string;
  /** Decoded body of a leaf part. */
  bytes: Uint8Array;
  /** Raw bytes of the whole entity, headers included. */
  raw: Uint8Array;
  children: MimePart[];
  headers: Record<string, string>;
}

export interface FlattenedMime {
  html?: string;
  text?: string;
  attachments: {
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    cid?: string;
    disposition: string;
  }[];
}

interface Budget { parts: number; bytes: number }

function splitHeaders(raw: Uint8Array): { headerText: string; bodyStart: number } {
  // Look for CRLFCRLF, tolerating bare-LF messages.
  const limit = Math.min(raw.length, 256 * 1024);
  for (let i = 0; i + 1 < limit; i++) {
    if (raw[i] === 0x0a && raw[i + 1] === 0x0a) {
      return { headerText: bytesToUtf8(raw.subarray(0, i)), bodyStart: i + 2 };
    }
    if (
      raw[i] === 0x0d && raw[i + 1] === 0x0a
      && i + 3 < raw.length && raw[i + 2] === 0x0d && raw[i + 3] === 0x0a
    ) {
      return { headerText: bytesToUtf8(raw.subarray(0, i)), bodyStart: i + 4 };
    }
  }
  return { headerText: bytesToUtf8(raw.subarray(0, limit)), bodyStart: raw.length };
}

function parseHeaders(headerText: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Unfold continuation lines before splitting.
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    out[name] = name in out ? `${out[name]}, ${value}` : value;
  }
  return out;
}

export function parseContentTypeHeader(value: string | undefined): {
  type: string;
  params: Record<string, string>;
} {
  if (!value) return { type: 'text/plain', params: {} };

  // Split on `;` but not inside a quoted string — `boundary="a;b"` is legal and
  // a naive split would truncate the boundary, silently breaking part detection.
  const chunks: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== '\\') inQuotes = !inQuotes;
    if (ch === ';' && !inQuotes) {
      chunks.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  chunks.push(current);

  const params: Record<string, string> = {};
  for (const chunk of chunks.slice(1)) {
    const eq = chunk.indexOf('=');
    if (eq < 0) continue;
    const key = chunk.slice(0, eq).trim().toLowerCase();
    let raw = chunk.slice(eq + 1).trim();
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    params[key] = raw.replace(/\\"/g, '"');
  }
  return { type: (chunks[0] ?? '').trim().toLowerCase(), params };
}

function decodeQuotedPrintable(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '=') {
      const next2 = text.slice(i + 1, i + 3);
      if (/^\r?\n/.test(text.slice(i + 1))) {
        // Soft line break.
        i += text[i + 1] === '\r' ? 2 : 1;
        continue;
      }
      if (/^[0-9a-fA-F]{2}$/.test(next2)) {
        out.push(parseInt(next2, 16));
        i += 2;
        continue;
      }
    }
    out.push(ch.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(out);
}

function decodeBody(bytes: Uint8Array, encoding: string | undefined): Uint8Array {
  const enc = (encoding ?? '7bit').trim().toLowerCase();
  if (enc === 'base64') {
    try {
      const cleaned = bytesToUtf8(bytes).replace(/[^A-Za-z0-9+/=]/g, '');
      return binaryToBytes(forge.util.decode64(cleaned));
    } catch {
      return bytes;
    }
  }
  if (enc === 'quoted-printable') {
    // Latin-1 view is correct here: QP operates on octets, and the charset is
    // applied afterwards by decodeText.
    let latin = '';
    for (let i = 0; i < bytes.length; i++) latin += String.fromCharCode(bytes[i]);
    return decodeQuotedPrintable(latin);
  }
  return bytes;
}

/** Decode bytes to text using the part's charset, falling back to latin-1. */
export function decodeText(bytes: Uint8Array, charset?: string): string {
  const label = (charset ?? 'utf-8').toLowerCase();
  if (label !== 'utf-8' && label !== 'utf8' && label !== 'us-ascii' && label !== 'ascii') {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Hermes ships a utf-8-only TextDecoder; latin-1 by hand is the safest
      // universal fallback and is byte-compatible for the ASCII range.
      let out = '';
      for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
      return out;
    }
  }
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return bytesToUtf8(bytes);
  }
}

function findBoundaryParts(body: Uint8Array, boundary: string): Uint8Array[] {
  // Split on CRLF--boundary. Delimiters are matched on the raw octets so a
  // part's own bytes are preserved exactly (required for detached signatures).
  const marker = bytesToBinary(new TextEncoder().encode(`--${boundary}`));
  const haystack = bytesToBinary(body);
  const parts: Uint8Array[] = [];
  let searchFrom = 0;
  const offsets: number[] = [];
  for (;;) {
    const at = haystack.indexOf(marker, searchFrom);
    if (at === -1) break;
    // Must be at the start of a line.
    if (at === 0 || haystack[at - 1] === '\n') offsets.push(at);
    searchFrom = at + marker.length;
  }
  for (let i = 0; i < offsets.length - 1; i++) {
    const start = offsets[i] + marker.length;
    // Skip the CRLF that terminates the boundary line.
    let contentStart = start;
    if (haystack[contentStart] === '\r') contentStart++;
    if (haystack[contentStart] === '\n') contentStart++;
    let end = offsets[i + 1];
    // Trim the CRLF that precedes the next boundary — it belongs to the
    // delimiter, not to the part.
    if (end > contentStart && haystack[end - 1] === '\n') end--;
    if (end > contentStart && haystack[end - 1] === '\r') end--;
    if (end > contentStart) parts.push(body.subarray(contentStart, end));
  }
  return parts;
}

function parseEntity(raw: Uint8Array, depth: number, budget: Budget): MimePart {
  budget.parts += 1;
  budget.bytes += raw.length;

  const { headerText, bodyStart } = splitHeaders(raw);
  const headers = parseHeaders(headerText);
  const { type, params } = parseContentTypeHeader(headers['content-type']);
  const disposition = parseContentTypeHeader(headers['content-disposition']);

  const bodyRaw = raw.subarray(bodyStart);
  const part: MimePart = {
    contentType: type,
    charset: params.charset,
    disposition: disposition.type || undefined,
    filename: disposition.params.filename ?? params.name,
    cid: headers['content-id']?.replace(/^<|>$/g, ''),
    bytes: new Uint8Array(0),
    raw,
    children: [],
    headers,
  };

  const isMultipart = type.startsWith('multipart/') && !!params.boundary;
  const withinBudget = depth < MAX_DEPTH && budget.parts < MAX_PARTS && budget.bytes < MAX_BYTES;

  if (isMultipart && withinBudget) {
    for (const child of findBoundaryParts(bodyRaw, params.boundary)) {
      if (budget.parts >= MAX_PARTS || budget.bytes >= MAX_BYTES) break;
      part.children.push(parseEntity(child, depth + 1, budget));
    }
    return part;
  }

  part.bytes = decodeBody(bodyRaw, headers['content-transfer-encoding']);
  return part;
}

/** Parse a complete MIME entity (headers + body). */
export function parseMime(raw: Uint8Array): MimePart {
  return parseEntity(raw, 0, { parts: 0, bytes: 0 });
}

/** Collapse a parsed tree into the body text/html plus attachments. */
export function flattenMime(root: MimePart): FlattenedMime {
  const out: FlattenedMime = { attachments: [] };

  const pushAttachment = (part: MimePart) => {
    out.attachments.push({
      filename: part.filename ?? 'attachment',
      contentType: part.contentType,
      bytes: part.bytes,
      cid: part.cid,
      disposition: part.disposition ?? 'attachment',
    });
  };

  const visit = (part: MimePart) => {
    if (part.children.length > 0) {
      for (const child of part.children) visit(child);
      return;
    }
    // An explicit attachment disposition wins, even for text/*: that is how a
    // sender says "this is a file, not the body".
    if (part.disposition === 'attachment') {
      pushAttachment(part);
      return;
    }
    if (part.contentType === 'text/html') {
      const text = decodeText(part.bytes, part.charset);
      out.html = out.html ? `${out.html}${text}` : text;
      return;
    }
    if (part.contentType === 'text/plain') {
      const text = decodeText(part.bytes, part.charset);
      out.text = out.text ? `${out.text}${text}` : text;
      return;
    }
    // Anything else (images, PDFs, inline parts) is surfaced as an attachment.
    pushAttachment(part);
  };

  visit(root);
  return out;
}

/** Concatenate helper re-exported so callers do not need `der.ts` directly. */
export { concatBytes };
