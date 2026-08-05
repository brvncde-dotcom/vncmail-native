/**
 * The certificate auto-import gate.
 *
 * ── Cert substitution (audited webmail finding 1) ───────────────────────
 * "Save public certificates from signed messages" is a genuinely useful
 * convenience and a genuinely dangerous one. Upstream imported the signer
 * certificate from any signed message it could parse. That let anyone who could
 * send mail as (or spoof the From of) a correspondent install their own
 * certificate under that correspondent's address — after which every message
 * the user encrypted "to" that person was encrypted to the attacker.
 *
 * Five conditions, all required, none of them clever:
 *   1. the user turned the feature on;
 *   2. the signature actually verified (not merely "a signature was present");
 *   3. the certificate asserts an rfc822 address;
 *   4. that address is exactly the message's From address — `signerEmailMatch`
 *      must be literally `true`, so an undecidable case (no From header, no
 *      addresses in the certificate) fails closed;
 *   5. the certificate is not self-signed. This is the one that stops the
 *      attack: minting a self-signed certificate for someone else's address is
 *      free, while getting a CA to issue one is the whole point of a CA.
 *
 * And one condition upstream did not have at all: **never silently replace an
 * existing certificate.** Even a CA-signed certificate arriving by mail must not
 * overwrite the certificate already on file for that address. Replacement is the
 * substitution attack; it stays a manual, deliberate act.
 */
import type { SignatureStatus } from './cms-verify';
import type { StoredCertRecord } from './keystore';

export type AutoImportRefusal =
  | 'disabled'
  | 'no-certificate'
  | 'signature-invalid'
  | 'no-address'
  | 'address-mismatch'
  | 'self-signed'
  | 'already-known'
  | 'conflicts-with-stored';

export type AutoImportDecision =
  | { action: 'import'; address: string }
  | { action: 'skip'; reason: AutoImportRefusal };

export interface AutoImportContext {
  status: SignatureStatus;
  fromAddress?: string;
  enabled: boolean;
  /** Certificates already on file, so we never overwrite one. */
  existing: StoredCertRecord[];
}

export function decideAutoImport(context: AutoImportContext): AutoImportDecision {
  const { status, fromAddress, enabled, existing } = context;

  if (!enabled) return { action: 'skip', reason: 'disabled' };

  const cert = status.signerCertificate;
  if (!cert) return { action: 'skip', reason: 'no-certificate' };

  // Deliberately `!== true`, not `!`: a verification that could not be
  // completed is not a verification that passed.
  if (status.signatureValid !== true) return { action: 'skip', reason: 'signature-invalid' };

  if (cert.emailAddresses.length === 0) return { action: 'skip', reason: 'no-address' };

  if (status.signerEmailMatch !== true || !fromAddress) {
    return { action: 'skip', reason: 'address-mismatch' };
  }

  if (status.selfSigned === true) return { action: 'skip', reason: 'self-signed' };

  const address = fromAddress.trim().toLowerCase();
  const stored = existing.filter((r) => r.email === address);
  if (stored.some((r) => r.fingerprint === cert.fingerprint)) {
    return { action: 'skip', reason: 'already-known' };
  }
  if (stored.length > 0) {
    // A *different* certificate already exists for this address. Keep it.
    return { action: 'skip', reason: 'conflicts-with-stored' };
  }

  return { action: 'import', address };
}

export function describeRefusal(reason: AutoImportRefusal): string {
  switch (reason) {
    case 'disabled': return 'Auto-import is turned off.';
    case 'no-certificate': return 'The message carries no signer certificate.';
    case 'signature-invalid': return 'The signature did not verify.';
    case 'no-address': return 'The certificate asserts no email address.';
    case 'address-mismatch': return 'The certificate does not match the sender address.';
    case 'self-signed': return 'The certificate is self-signed and was not saved.';
    case 'already-known': return 'This certificate is already saved.';
    case 'conflicts-with-stored':
      return 'A different certificate is already saved for this sender. It was kept; '
        + 'import the new one manually if you trust it.';
  }
}
