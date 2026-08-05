/**
 * Build an outgoing S/MIME message.
 *
 * Always **sign-then-encrypt**: the signature is made over the plaintext and
 * ends up inside the envelope. The reverse order (encrypt-then-sign) tells the
 * recipient only that someone forwarded a blob, and lets a third party strip the
 * signature and reattach their own. Sign-then-encrypt also means our encrypted
 * mail carries an inner integrity proof independent of the cipher.
 *
 * Signature form:
 *   • sign only         → `multipart/signed` (detached), so a recipient without
 *                         S/MIME still reads the body instead of an attachment
 *   • sign + encrypt    → the same `multipart/signed` entity, encrypted whole
 *   • encrypt only      → `application/pkcs7-mime; smime-type=enveloped-data`
 */
import { bytesToHex, concatBytes, utf8ToBytes } from './der';
import { randomBytes } from './forge';
import type { CertificateInfo } from './certificate';
import { buildSignedData } from './cms-sign';
import { buildEnvelopedData, SmimeEncryptError } from './cms-encrypt';
import {
  buildInnerMime, buildRfc822, CRLF, makeBoundary, wrapMultipartSigned, wrapPkcs7Mime,
  type MailAddress, type MimeAttachmentPart, type OuterHeaders,
} from './mime-builder';
import { SIGNING_DIGEST } from './oids';
import type { ForgePrivateKey } from './forge';

export interface SigningIdentity {
  privateKey: ForgePrivateKey;
  certificate: CertificateInfo;
  chain?: CertificateInfo[];
}

export interface BuildOutgoingInput {
  from: MailAddress[];
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: MimeAttachmentPart[];
  inReplyTo?: string;
  references?: string;
  messageId: string;
  date?: Date;
  sign?: SigningIdentity;
  /**
   * Recipient certificates. The sender's own certificate must be included by the
   * caller — otherwise the copy in Sent is unreadable, which users experience as
   * data loss.
   */
  encryptTo?: CertificateInfo[];
  keyLength?: 128 | 256;
}

interface MimeEntity {
  headers: string[];
  body: Uint8Array;
}

function serializeEntity(entity: MimeEntity): Uint8Array {
  return concatBytes([
    utf8ToBytes(`${entity.headers.join(CRLF)}${CRLF}${CRLF}`),
    entity.body,
  ]);
}

function boundary(prefix: string): string {
  return makeBoundary(prefix, bytesToHex(randomBytes(12)));
}

export interface BuiltMessage {
  bytes: Uint8Array;
  signed: boolean;
  encrypted: boolean;
}

export function buildOutgoingSmime(input: BuildOutgoingInput): BuiltMessage {
  if (!input.sign && !input.encryptTo?.length) {
    throw new SmimeEncryptError('Nothing to do: neither signing nor encryption was requested.');
  }

  // The content that gets protected. Carries content headers only; the
  // addressing headers stay on the outer message.
  const innerBytes = buildInnerMime({
    text: input.text,
    html: input.html,
    attachments: input.attachments,
    boundaries: { alternative: boundary('alt'), mixed: boundary('mix') },
  });

  let protectedEntity: MimeEntity | undefined;
  let signed = false;

  if (input.sign) {
    const cms = buildSignedData({
      content: innerBytes,
      privateKey: input.sign.privateKey,
      signerCertificate: input.sign.certificate,
      chain: input.sign.chain,
      detached: true,
      digest: SIGNING_DIGEST,
      signingTime: input.date,
    });
    protectedEntity = wrapMultipartSigned(innerBytes, cms, SIGNING_DIGEST, boundary('sig'));
    signed = true;
  }

  const outer: OuterHeaders = {
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    date: input.date,
    messageId: input.messageId,
    inReplyTo: input.inReplyTo,
    references: input.references,
  };

  if (input.encryptTo?.length) {
    const payload = protectedEntity
      ? serializeEntity(protectedEntity)
      // innerBytes already begins with its own content headers.
      : innerBytes;
    const cms = buildEnvelopedData({
      content: payload,
      recipients: input.encryptTo,
      keyLength: input.keyLength,
    });
    return {
      bytes: buildRfc822(outer, wrapPkcs7Mime(cms, 'enveloped-data')),
      signed,
      encrypted: true,
    };
  }

  return {
    bytes: buildRfc822(outer, protectedEntity!),
    signed,
    encrypted: false,
  };
}

/** RFC 5322 Message-ID local part, from the CSPRNG. */
export function generateMessageId(domain: string): string {
  const host = domain.replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  return `${bytesToHex(randomBytes(16))}@${host}`;
}
