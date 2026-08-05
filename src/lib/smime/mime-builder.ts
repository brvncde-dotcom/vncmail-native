/**
 * Deterministic CRLF MIME builder for S/MIME.
 *
 * ── Header injection (audited webmail finding 3) ───────────────────────
 * Every header this module emits goes through `formatHeader`, which runs the
 * value through `stripCrlf` first. Without that, a display name of
 * `Evil\r\nBcc: attacker@evil.com` becomes a real Bcc header the moment the
 * message is assembled — a silent blind-copy of mail the user believes is
 * private, and in an S/MIME context a way to add a recipient the encryption
 * layer never saw. `stripCrlf` is applied to *values* only; the structural
 * separators are literals in this file.
 *
 * The rule enforced by the tests: no header line may be assembled by string
 * interpolation of an unsanitised value. Anything user- or network-influenced
 * (display names, subjects, filenames, content types, content ids) is either
 * passed through `formatHeader`/`stripCrlf` or wrapped in an encoded-word,
 * which cannot contain a bare CR or LF by construction.
 */
import { bytesToBase64, concatBytes, utf8ToBytes } from './der';
import { MICALG_BY_DIGEST, type DigestName } from './oids';

export const CRLF = '\r\n';

/**
 * Collapse any CR/LF (and the folding whitespace that may follow) into a single
 * space, so a value can never terminate its header or start a new one.
 */
export function stripCrlf(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+[ \t]*/g, ' ');
}

const NON_ASCII = /[^\x20-\x7e]/;

/**
 * RFC 2047 encoded-word for a header value containing non-ASCII. Base64 of
 * UTF-8, split so no single encoded-word exceeds the 75-character limit.
 * Encoded-words are inherently CRLF-free, which is why this is safe to emit.
 */
export function encodeHeaderValue(value: string): string {
  const clean = stripCrlf(value);
  if (!NON_ASCII.test(clean)) return clean;

  // 75 chars total per encoded-word; "=?UTF-8?B?" + "?=" is 12, and base64
  // grows 3 bytes into 4 chars, so cap each chunk at 45 source bytes.
  const bytes = utf8ToBytes(clean);
  const words: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + 45, bytes.length);
    // Never split a UTF-8 sequence: back off while the next byte is a
    // continuation byte (10xxxxxx).
    while (end > start + 1 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    words.push(`=?UTF-8?B?${bytesToBase64(bytes.subarray(start, end))}?=`);
    start = end;
  }
  return words.join(`${CRLF} `);
}

/** The only sanctioned way to produce a header line. */
export function formatHeader(name: string, rawValue: unknown): string {
  return `${name}: ${encodeHeaderValue(stripCrlf(rawValue))}`;
}

export interface MailAddress {
  name?: string;
  email: string;
}

/** `"Display Name" <addr@example.com>`, with both halves sanitised. */
export function formatAddress(address: MailAddress): string {
  const email = stripCrlf(address.email).replace(/[<>,]/g, '').trim();
  const name = stripCrlf(address.name ?? '').trim();
  if (!name) return email;
  return `${encodeHeaderValue(name).includes('=?') ? encodeHeaderValue(name) : `"${name.replace(/["\\]/g, '')}"`} <${email}>`;
}

export function formatAddressList(addresses: MailAddress[]): string {
  return addresses.map(formatAddress).join(', ');
}

/** Wrap base64 at 76 columns with CRLF, as required for MIME transport. */
export function base64Body(bytes: Uint8Array): string {
  const b64 = bytesToBase64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF) + (lines.length ? CRLF : '');
}

/** A boundary that cannot appear in base64 content and carries no user input. */
export function makeBoundary(prefix: string, randomHex: string): string {
  return `----=_${prefix}_${randomHex}`;
}

export interface MimeAttachmentPart {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  /** 'attachment' | 'inline' */
  disposition?: string;
  /** Content-ID without angle brackets. */
  cid?: string;
}

export interface InnerMimeInput {
  text?: string;
  html?: string;
  attachments?: MimeAttachmentPart[];
  /** Boundary source; must be caller-supplied so this module stays pure. */
  boundaries: { alternative: string; mixed: string };
}

/**
 * Build the MIME entity that gets signed and/or encrypted. Deliberately carries
 * only content headers — the addressing headers live on the outer message.
 */
export function buildInnerMime(input: InnerMimeInput): Uint8Array {
  const { text, html, attachments = [], boundaries } = input;

  const bodyEntity = ((): { headers: string[]; body: Uint8Array } => {
    if (text != null && html != null) {
      const parts: Uint8Array[] = [];
      parts.push(utf8ToBytes(
        `--${boundaries.alternative}${CRLF}`
        + `Content-Type: text/plain; charset=utf-8${CRLF}`
        + `Content-Transfer-Encoding: base64${CRLF}${CRLF}`,
      ));
      parts.push(utf8ToBytes(base64Body(utf8ToBytes(text))));
      parts.push(utf8ToBytes(
        `${CRLF}--${boundaries.alternative}${CRLF}`
        + `Content-Type: text/html; charset=utf-8${CRLF}`
        + `Content-Transfer-Encoding: base64${CRLF}${CRLF}`,
      ));
      parts.push(utf8ToBytes(base64Body(utf8ToBytes(html))));
      parts.push(utf8ToBytes(`${CRLF}--${boundaries.alternative}--${CRLF}`));
      return {
        headers: [`Content-Type: multipart/alternative; boundary="${boundaries.alternative}"`],
        body: concatBytes(parts),
      };
    }
    const single = html ?? text ?? '';
    const type = html != null ? 'text/html' : 'text/plain';
    return {
      headers: [
        `Content-Type: ${type}; charset=utf-8`,
        'Content-Transfer-Encoding: base64',
      ],
      body: utf8ToBytes(base64Body(utf8ToBytes(single))),
    };
  })();

  if (attachments.length === 0) {
    return concatBytes([
      utf8ToBytes(`${bodyEntity.headers.join(CRLF)}${CRLF}${CRLF}`),
      bodyEntity.body,
    ]);
  }

  const parts: Uint8Array[] = [];
  parts.push(utf8ToBytes(
    `Content-Type: multipart/mixed; boundary="${boundaries.mixed}"${CRLF}${CRLF}`
    + `--${boundaries.mixed}${CRLF}`
    + `${bodyEntity.headers.join(CRLF)}${CRLF}${CRLF}`,
  ));
  parts.push(bodyEntity.body);

  for (const att of attachments) {
    const headers = [
      // stripCrlf on the content type: it comes from a file picker / remote
      // message and would otherwise be a header-injection vector.
      `Content-Type: ${stripCrlf(att.contentType) || 'application/octet-stream'}`,
      'Content-Transfer-Encoding: base64',
      formatHeader('Content-Disposition',
        `${stripCrlf(att.disposition ?? 'attachment')}; filename="${stripCrlf(att.filename).replace(/["\\]/g, '')}"`),
    ];
    if (att.cid) headers.push(`Content-ID: <${stripCrlf(att.cid).replace(/[<>]/g, '')}>`);
    parts.push(utf8ToBytes(`${CRLF}--${boundaries.mixed}${CRLF}${headers.join(CRLF)}${CRLF}${CRLF}`));
    parts.push(utf8ToBytes(base64Body(att.bytes)));
  }

  parts.push(utf8ToBytes(`${CRLF}--${boundaries.mixed}--${CRLF}`));
  return concatBytes(parts);
}

/**
 * `application/pkcs7-mime` body for opaque signed or enveloped CMS.
 * Returns content headers plus a base64 body, ready to be appended to the
 * outer message's headers.
 */
export function wrapPkcs7Mime(
  cmsDer: Uint8Array,
  smimeType: 'signed-data' | 'enveloped-data',
): { headers: string[]; body: Uint8Array } {
  const filename = smimeType === 'signed-data' ? 'smime.p7m' : 'smime.p7m';
  return {
    headers: [
      `Content-Type: application/pkcs7-mime; smime-type=${smimeType}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
    ],
    body: utf8ToBytes(base64Body(cmsDer)),
  };
}

/**
 * `multipart/signed` body (RFC 5751 §3.4.3) — the detached form, which every
 * client can read even without S/MIME support.
 */
export function wrapMultipartSigned(
  signedContent: Uint8Array,
  cmsDer: Uint8Array,
  digest: DigestName,
  boundary: string,
): { headers: string[]; body: Uint8Array } {
  return {
    headers: [
      `Content-Type: multipart/signed; protocol="application/pkcs7-signature"; `
      + `micalg=${MICALG_BY_DIGEST[digest]}; boundary="${boundary}"`,
    ],
    body: concatBytes([
      utf8ToBytes(`--${boundary}${CRLF}`),
      signedContent,
      utf8ToBytes(
        `${CRLF}--${boundary}${CRLF}`
        + `Content-Type: application/pkcs7-signature; name="smime.p7s"${CRLF}`
        + `Content-Transfer-Encoding: base64${CRLF}`
        + `Content-Disposition: attachment; filename="smime.p7s"${CRLF}${CRLF}`,
      ),
      utf8ToBytes(base64Body(cmsDer)),
      utf8ToBytes(`${CRLF}--${boundary}--${CRLF}`),
    ]),
  };
}

export interface OuterHeaders {
  from: MailAddress[];
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  date?: Date;
  messageId: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * Assemble the complete RFC 822 message: addressing headers, then the content
 * headers and body produced by one of the wrappers above.
 */
export function buildRfc822(
  outer: OuterHeaders,
  content: { headers: string[]; body: Uint8Array },
): Uint8Array {
  const lines: string[] = [];
  lines.push('MIME-Version: 1.0');
  lines.push(formatHeader('Date', (outer.date ?? new Date()).toUTCString().replace('GMT', '+0000')));
  // Message-ID is generated locally from a uuid; strip anyway so a future
  // caller cannot smuggle a header through it.
  lines.push(`Message-ID: <${stripCrlf(outer.messageId).replace(/[<>\s]/g, '')}>`);
  lines.push(formatHeader('From', formatAddressList(outer.from)));
  if (outer.to.length) lines.push(formatHeader('To', formatAddressList(outer.to)));
  if (outer.cc?.length) lines.push(formatHeader('Cc', formatAddressList(outer.cc)));
  // Bcc is intentionally NOT emitted: it must not travel with the message. The
  // recipients are carried in the JMAP submission envelope instead.
  lines.push(formatHeader('Subject', outer.subject));
  if (outer.inReplyTo) lines.push(formatHeader('In-Reply-To', outer.inReplyTo));
  if (outer.references) lines.push(formatHeader('References', outer.references));
  for (const header of content.headers) lines.push(header);

  return concatBytes([utf8ToBytes(lines.join(CRLF) + CRLF + CRLF), content.body]);
}
