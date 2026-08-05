/**
 * Bridge between the composer and the CMS layer.
 *
 * Keeps ComposeScreen free of crypto: it hands over the addresses, the body and
 * the attachment URIs, and gets back the finished RFC 822 bytes. Everything that
 * can go wrong (no identity, a locked key, a recipient with no certificate) is
 * raised as a `SmimeComposeError` carrying a message the composer can show
 * verbatim.
 */
import type { EmailAddress } from '../../api/types';
import { getUnlockedKey } from './keystore';
import { findCertificateFor, findSigningIdentity } from './keystore';
import { buildOutgoingSmime, generateMessageId } from './send';
import { hasSecureRandom } from './forge';
import type { CertificateInfo } from './certificate';
import type { MimeAttachmentPart } from './mime-builder';

export class SmimeComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmimeComposeError';
  }
}

export interface ComposeAttachmentSource {
  uri: string;
  name: string;
  type: string;
  disposition: 'attachment' | 'inline';
  cid?: string;
}

export interface ComposeSmimeRequest {
  sign: boolean;
  encrypt: boolean;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  html?: string;
  text: string;
  attachments: ComposeAttachmentSource[];
  inReplyTo?: string;
  references?: string;
}

export interface ComposeSmimeOutcome {
  raw: Uint8Array;
  signed: boolean;
  encrypted: boolean;
  /** Every address the message actually goes to, Bcc included. */
  recipients: EmailAddress[];
}

async function readAttachments(
  sources: ComposeAttachmentSource[],
): Promise<MimeAttachmentPart[]> {
  if (sources.length === 0) return [];
  const { File } = await import('expo-file-system');
  const out: MimeAttachmentPart[] = [];
  for (const source of sources) {
    let bytes: Uint8Array;
    try {
      bytes = await new File(source.uri).bytes();
    } catch (err) {
      throw new SmimeComposeError(
        `Could not read the attachment "${source.name}": `
        + (err instanceof Error ? err.message : String(err)),
      );
    }
    out.push({
      filename: source.name,
      contentType: source.type || 'application/octet-stream',
      bytes,
      disposition: source.disposition,
      cid: source.cid,
    });
  }
  return out;
}

/** Certificates for every recipient, or a list of who is missing one. */
export async function resolveRecipientCertificates(
  addresses: EmailAddress[],
): Promise<{ certificates: CertificateInfo[]; missing: string[] }> {
  const certificates: CertificateInfo[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    const key = address.email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cert = await findCertificateFor(key);
    if (cert) certificates.push(cert);
    else missing.push(address.email);
  }
  return { certificates, missing };
}

export async function buildComposeSmime(
  request: ComposeSmimeRequest,
): Promise<ComposeSmimeOutcome> {
  if (!hasSecureRandom()) {
    throw new SmimeComposeError(
      'This device has no secure random source, so S/MIME cannot be used.',
    );
  }
  if (!request.sign && !request.encrypt) {
    throw new SmimeComposeError('Neither signing nor encryption was requested.');
  }

  const recipients = [...request.to, ...(request.cc ?? []), ...(request.bcc ?? [])];
  if (recipients.length === 0) throw new SmimeComposeError('Add at least one recipient.');

  let signing: Parameters<typeof buildOutgoingSmime>[0]['sign'];
  let ownCertificate: CertificateInfo | undefined;

  if (request.sign) {
    const identity = await findSigningIdentity(request.from.email);
    if (!identity) {
      throw new SmimeComposeError(
        `No S/MIME certificate is imported for ${request.from.email}. `
        + 'Import one under Settings → S/MIME Encryption.',
      );
    }
    const privateKey = getUnlockedKey(identity.record.id);
    if (!privateKey) {
      throw new SmimeComposeError(
        'Your S/MIME certificate is locked. Unlock it under Settings → S/MIME Encryption.',
      );
    }
    signing = { privateKey, certificate: identity.certificate, chain: identity.chain };
    ownCertificate = identity.certificate;
  }

  let encryptTo: CertificateInfo[] | undefined;
  if (request.encrypt) {
    const { certificates, missing } = await resolveRecipientCertificates(recipients);
    if (missing.length > 0) {
      throw new SmimeComposeError(
        `No certificate is available for ${missing.join(', ')}. `
        + 'Import their certificate, or turn encryption off for this message.',
      );
    }
    // Always encrypt to ourselves as well, or the copy filed in Sent is
    // unreadable — which users reasonably experience as losing the message.
    const own = ownCertificate ?? (await findCertificateFor(request.from.email));
    if (!own) {
      throw new SmimeComposeError(
        `No certificate is available for your own address (${request.from.email}), `
        + 'so the copy in Sent could not be read back. Import your certificate first.',
      );
    }
    encryptTo = [...certificates, own];
  }

  const domain = request.from.email.split('@')[1] ?? 'localhost';
  const built = buildOutgoingSmime({
    from: [request.from],
    to: request.to,
    cc: request.cc,
    bcc: request.bcc,
    subject: request.subject,
    text: request.text,
    html: request.html,
    attachments: await readAttachments(request.attachments),
    inReplyTo: request.inReplyTo,
    references: request.references,
    messageId: generateMessageId(domain),
    sign: signing,
    encryptTo,
  });

  return { raw: built.bytes, signed: built.signed, encrypted: built.encrypted, recipients };
}

/**
 * Can this message be signed / encrypted right now? Used to gate the composer
 * toggles so a user is told *why* an option is unavailable before they send.
 */
export async function smimeComposeCapabilities(
  fromAddress: string,
  recipients: EmailAddress[],
): Promise<{
  canSign: boolean;
  signReason?: string;
  canEncrypt: boolean;
  encryptReason?: string;
}> {
  if (!hasSecureRandom()) {
    const reason = 'No secure random source on this device.';
    return { canSign: false, signReason: reason, canEncrypt: false, encryptReason: reason };
  }

  const identity = await findSigningIdentity(fromAddress);
  const unlocked = identity ? !!getUnlockedKey(identity.record.id) : false;
  const canSign = !!identity && unlocked;
  const signReason = !identity
    ? `No certificate imported for ${fromAddress}.`
    : !unlocked
      ? 'Your certificate is locked.'
      : undefined;

  if (recipients.length === 0) {
    return { canSign, signReason, canEncrypt: false, encryptReason: 'Add a recipient first.' };
  }
  const { missing } = await resolveRecipientCertificates(recipients);
  const own = await findCertificateFor(fromAddress);
  const canEncrypt = missing.length === 0 && !!own;
  const encryptReason = missing.length > 0
    ? `No certificate for ${missing.join(', ')}.`
    : !own
      ? 'No certificate for your own address.'
      : undefined;

  return { canSign, signReason, canEncrypt, encryptReason };
}
