/**
 * OIDs and algorithm policy for the CMS layer.
 *
 * The content-encryption allowlist is the security-critical part of this file;
 * see CONTENT_ENCRYPTION_ALLOWLIST below.
 */

// ── CMS content types (RFC 5652) ───────────────────────────────────────
export const OID_DATA = '1.2.840.113549.1.7.1';
export const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
export const OID_ENVELOPED_DATA = '1.2.840.113549.1.7.3';
/** RFC 5083 AuthEnvelopedData — recognised so we can reject it explicitly. */
export const OID_AUTH_ENVELOPED_DATA = '1.2.840.113549.1.9.16.1.23';

// ── Signed attributes ──────────────────────────────────────────────────
export const OID_ATTR_CONTENT_TYPE = '1.2.840.113549.1.9.3';
export const OID_ATTR_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
export const OID_ATTR_SIGNING_TIME = '1.2.840.113549.1.9.5';

// ── Digests ────────────────────────────────────────────────────────────
export const OID_SHA1 = '1.3.14.3.2.26';
export const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
export const OID_SHA384 = '2.16.840.1.101.3.4.2.2';
export const OID_SHA512 = '2.16.840.1.101.3.4.2.3';

// ── Signature / key transport ──────────────────────────────────────────
export const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
export const OID_RSAES_OAEP = '1.2.840.113549.1.1.7';
export const OID_RSA_SHA256 = '1.2.840.113549.1.1.11';
export const OID_MGF1 = '1.2.840.113549.1.1.8';
export const OID_P_SPECIFIED = '1.2.840.113549.1.1.9';

// ── Certificate extensions ─────────────────────────────────────────────
export const OID_EXT_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
export const OID_EXT_SUBJECT_ALT_NAME = '2.5.29.17';

export type DigestName = 'sha1' | 'sha256' | 'sha384' | 'sha512';

/**
 * Digest OIDs we accept on incoming signatures.
 *
 * SHA-1 is accepted for *verification only* — a decade of Outlook/Thunderbird
 * mail is signed with it and refusing to parse it would show "broken signature"
 * on messages that are merely old. It is never used for signing (see
 * SIGNING_DIGEST) and `digestIsWeak` lets the UI say so.
 */
export const DIGEST_BY_OID: Record<string, DigestName> = {
  [OID_SHA1]: 'sha1',
  [OID_SHA256]: 'sha256',
  [OID_SHA384]: 'sha384',
  [OID_SHA512]: 'sha512',
};

export const OID_BY_DIGEST: Record<DigestName, string> = {
  sha1: OID_SHA1,
  sha256: OID_SHA256,
  sha384: OID_SHA384,
  sha512: OID_SHA512,
};

/** What we sign with. Never SHA-1. */
export const SIGNING_DIGEST: DigestName = 'sha256';

export function digestIsWeak(name: DigestName): boolean {
  return name === 'sha1';
}

/** `micalg` value for the multipart/signed Content-Type parameter (RFC 5751 §3.4.3.1). */
export const MICALG_BY_DIGEST: Record<DigestName, string> = {
  sha1: 'sha1',
  sha256: 'sha-256',
  sha384: 'sha-384',
  sha512: 'sha-512',
};

export interface ContentEncryptionAlgorithm {
  name: string;
  /** forge cipher name. */
  cipher: 'AES-CBC' | 'AES-GCM';
  /** Key length in bytes. */
  keyLength: number;
  /**
   * True only for AEAD. The render path uses this to decide whether decrypted
   * plaintext may be treated as trusted HTML — see the EFAIL note below.
   */
  authenticated: boolean;
}

/**
 * Content-encryption allowlist. Ported deliberately from the audited webmail
 * plugin (`vnc/plugins/smime/src/smime-decrypt.js`, audit finding 2).
 *
 * Two things are going on here.
 *
 * 1. **Refusing broken ciphers.** DES-CBC (56-bit), 3DES-CBC and RC2-CBC are
 *    all still legal in deployed S/MIME and all still turn up in crafted mail.
 *    Their OIDs are absent from this table, and `resolveContentEncryption`
 *    throws on anything absent rather than falling through to a generic
 *    "unsupported, try anyway" path. The gate runs *before* any private key is
 *    touched, so a message asking to be decrypted under RC2 never reaches a
 *    decrypt primitive at all.
 *
 * 2. **EFAIL.** CMS EnvelopedData carries no integrity check, so AES-CBC
 *    ciphertext is malleable: an attacker who can resend a captured message can
 *    graft in a chosen-plaintext block that turns the decrypted body into an
 *    HTML exfiltration gadget. The tempting fix — allow AEAD only — would be a
 *    functionality catastrophe wearing a security fix's clothes: RFC 5751 makes
 *    AES-128-CBC the MUST-implement content cipher and both Outlook and
 *    Thunderbird default to CBC. So CBC stays accepted for interop, but the
 *    `authenticated` flag is propagated all the way to the renderer, which
 *    suppresses HTML (renders the body as plain text, no remote loads) for
 *    anything unauthenticated. That is the actual EFAIL mitigation: refusing to
 *    render unauthenticated plaintext as live HTML.
 */
export const CONTENT_ENCRYPTION_ALLOWLIST: Record<string, ContentEncryptionAlgorithm> = {
  '2.16.840.1.101.3.4.1.2': { name: 'AES-128-CBC', cipher: 'AES-CBC', keyLength: 16, authenticated: false },
  '2.16.840.1.101.3.4.1.22': { name: 'AES-192-CBC', cipher: 'AES-CBC', keyLength: 24, authenticated: false },
  '2.16.840.1.101.3.4.1.42': { name: 'AES-256-CBC', cipher: 'AES-CBC', keyLength: 32, authenticated: false },
  '2.16.840.1.101.3.4.1.6': { name: 'AES-128-GCM', cipher: 'AES-GCM', keyLength: 16, authenticated: true },
  '2.16.840.1.101.3.4.1.26': { name: 'AES-192-GCM', cipher: 'AES-GCM', keyLength: 24, authenticated: true },
  '2.16.840.1.101.3.4.1.46': { name: 'AES-256-GCM', cipher: 'AES-GCM', keyLength: 32, authenticated: true },
};

export const OID_AES_256_GCM = '2.16.840.1.101.3.4.1.46';
export const OID_AES_128_GCM = '2.16.840.1.101.3.4.1.6';

export class SmimeAlgorithmRefusedError extends Error {
  constructor(oid: string) {
    super(
      `Refusing to decrypt: unsupported or insecure content-encryption algorithm (${oid}). `
      + 'Only AES-CBC and AES-GCM are accepted.',
    );
    this.name = 'SmimeAlgorithmRefusedError';
  }
}

/** Allowlist gate. Throws for anything not explicitly permitted. */
export function resolveContentEncryption(oid: string | undefined): ContentEncryptionAlgorithm {
  if (!oid) throw new Error('Encrypted message has no content-encryption algorithm');
  const allowed = CONTENT_ENCRYPTION_ALLOWLIST[oid];
  if (!allowed) throw new SmimeAlgorithmRefusedError(oid);
  return allowed;
}
