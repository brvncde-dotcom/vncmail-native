/**
 * Regression guard for the three vulnerabilities fixed during the webmail S/MIME
 * audit, so the mobile port cannot quietly reacquire them.
 *
 * Two layers, deliberately:
 *   1. behavioural tests of the decision logic;
 *   2. source assertions, because several of these properties are about *where*
 *      a check happens (the algorithm gate must run before any private key is
 *      used) or about a rule holding for code not yet written (no header may be
 *      assembled from an unsanitised value). A behavioural test cannot see a new
 *      call site that skips the guard; a source assertion can.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideAutoImport } from '../smime/autoimport';
import { stripCrlf, formatHeader, formatAddress, encodeHeaderValue } from '../smime/mime-builder';
import {
  CONTENT_ENCRYPTION_ALLOWLIST, resolveContentEncryption, SmimeAlgorithmRefusedError,
} from '../smime/oids';
import type { CertificateInfo } from '../smime/certificate';
import type { SignatureStatus } from '../smime/cms-verify';
import type { StoredCertRecord } from '../smime/keystore';

const SMIME_DIR = join(__dirname, '..', 'smime');
const source = (name: string) => readFileSync(join(SMIME_DIR, name), 'utf8');

/**
 * Source with comments removed. These files explain the attacks they defend
 * against, so an assertion like "Math.random must not appear" has to look at the
 * code rather than the prose describing why it is absent.
 */
const code = (name: string) => source(name)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const cert = {
  fingerprint: 'aa'.repeat(32),
  emailAddresses: ['alice@example.com'],
  subject: 'CN=Alice',
} as unknown as CertificateInfo;

const validStatus: SignatureStatus = {
  signatureValid: true,
  signerCertificate: cert,
  signerEmailMatch: true,
  selfSigned: false,
};

const gate = (
  status: Partial<SignatureStatus>,
  opts: { from?: string; enabled?: boolean; existing?: StoredCertRecord[] } = {},
) => decideAutoImport({
  status: { ...validStatus, ...status },
  fromAddress: 'from' in opts ? opts.from : 'alice@example.com',
  enabled: opts.enabled ?? true,
  existing: opts.existing ?? [],
});

describe('finding 1 — certificate auto-import gate (cert substitution)', () => {
  it('imports a CA-signed certificate whose address matches the sender', () => {
    expect(gate({}).action).toBe('import');
  });

  it('THE ATTACK: refuses a self-signed certificate even when the address matches', () => {
    const decision = gate({ selfSigned: true });
    expect(decision).toEqual({ action: 'skip', reason: 'self-signed' });
  });

  it('refuses when the certificate does not assert the From address', () => {
    expect(gate({ signerEmailMatch: false })).toEqual({ action: 'skip', reason: 'address-mismatch' });
  });

  it('fails closed when the address match is undecidable', () => {
    // `signerEmailMatch: undefined` must never be read as a match.
    expect(gate({ signerEmailMatch: undefined }, { from: undefined }))
      .toEqual({ action: 'skip', reason: 'address-mismatch' });
  });

  it('refuses when the signature did not verify', () => {
    expect(gate({ signatureValid: false })).toEqual({ action: 'skip', reason: 'signature-invalid' });
  });

  it('refuses when the certificate asserts no address at all', () => {
    expect(gate({ signerCertificate: { ...cert, emailAddresses: [] } }))
      .toEqual({ action: 'skip', reason: 'no-address' });
  });

  it('respects the user setting', () => {
    expect(gate({}, { enabled: false })).toEqual({ action: 'skip', reason: 'disabled' });
  });

  it('never replaces a certificate already on file for that address', () => {
    const existing: StoredCertRecord[] = [{
      id: 'x', email: 'alice@example.com', subject: '', issuer: '',
      notBefore: '', notAfter: '', fingerprint: 'bb'.repeat(32),
      certificate: '', source: 'manual', addedAt: '',
    }];
    expect(gate({}, { existing })).toEqual({ action: 'skip', reason: 'conflicts-with-stored' });
  });

  it('is a no-op for a certificate it already has', () => {
    const existing: StoredCertRecord[] = [{
      id: 'x', email: 'alice@example.com', subject: '', issuer: '',
      notBefore: '', notAfter: '', fingerprint: cert.fingerprint,
      certificate: '', source: 'signed-email', addedAt: '',
    }];
    expect(gate({}, { existing })).toEqual({ action: 'skip', reason: 'already-known' });
  });

  it('keeps the guard order in the source', () => {
    const src = source('autoimport.ts');
    expect(src).toContain('status.signatureValid !== true');
    expect(src).toContain('status.signerEmailMatch !== true');
    expect(src).toContain('status.selfSigned === true');
    expect(src).toContain("reason: 'conflicts-with-stored'");
  });
});

describe('finding 3 — CRLF header injection', () => {
  it('collapses an injected Bcc header in a display name', () => {
    expect(stripCrlf('Evil\r\nBcc: attacker@evil.com')).toBe('Evil Bcc: attacker@evil.com');
  });

  it.each([
    ['bare LF', 'a\nb', 'a b'],
    ['bare CR', 'a\rb', 'a b'],
    ['folded continuation', 'a\r\n\tb', 'a b'],
    ['multiple headers', 'x\r\nBcc: a@b.c\r\nReply-To: d@e.f', 'x Bcc: a@b.c Reply-To: d@e.f'],
    ['clean value', 'Normal Subject', 'Normal Subject'],
    ['non-ASCII', 'Grüße büro', 'Grüße büro'],
  ])('%s', (_name, input, expected) => {
    expect(stripCrlf(input)).toBe(expected);
  });

  it('never emits a bare newline from formatHeader', () => {
    // Folding (CRLF + space) is legal; a bare CR/LF is not.
    const line = formatHeader('Subject', 'a\r\nBcc: x@y.z');
    expect(line.replace(/\r\n /g, ' ')).not.toMatch(/[\r\n]/);
  });

  it('cannot escape an address through the display name', () => {
    expect(formatAddress({ name: 'Evil\r\nBcc: a@b.c', email: 'alice@example.com' }))
      .not.toMatch(/[\r\n]/);
  });

  it('emits encoded-words with no bare newline for long non-ASCII values', () => {
    expect(encodeHeaderValue('Grüße'.repeat(40)).replace(/\r\n /g, '')).not.toMatch(/[\r\n]/);
  });

  it('routes every emitted header through the sanitiser', () => {
    const src = source('mime-builder.ts');
    expect(/export function formatHeader[\s\S]{0,200}stripCrlf\(rawValue\)/.test(src)).toBe(true);
    expect(src).toContain('stripCrlf(att.contentType)');
    expect(src).toContain('stripCrlf(att.filename)');
    expect(src).toContain('stripCrlf(att.cid)');
    // Any header line built by interpolation must interpolate a sanitised value
    // or a locally generated one (boundary, literal content type).
    const interpolated = [...src.matchAll(/`([A-Za-z-]+): ([^`]*)`/g)]
      // `${CRLF}` is a module constant, not a value from outside.
      .map(([match, name, value]) => [match, name, value.split('${CRLF}').join('')] as const)
      .filter(([, , value]) => /\$\{/.test(value))
      .filter(([, , value]) => !/stripCrlf|encodeHeaderValue|boundar|filename|smimeType|MICALG_BY_DIGEST|type|messageId/.test(value));
    expect(interpolated.map(([m]) => m)).toEqual([]);
  });

  it('does not put Bcc on the wire', () => {
    const src = source('mime-builder.ts');
    expect(src).not.toMatch(/lines\.push\(formatHeader\('Bcc'/);
  });
});

describe('finding 2 — unauthenticated CBC / EFAIL', () => {
  it('accepts the AES family only', () => {
    expect(Object.keys(CONTENT_ENCRYPTION_ALLOWLIST).sort()).toEqual([
      '2.16.840.1.101.3.4.1.2',
      '2.16.840.1.101.3.4.1.22',
      '2.16.840.1.101.3.4.1.26',
      '2.16.840.1.101.3.4.1.42',
      '2.16.840.1.101.3.4.1.46',
      '2.16.840.1.101.3.4.1.6',
    ].sort());
  });

  it.each([
    ['3DES-CBC', '1.2.840.113549.3.7'],
    ['DES-CBC', '1.3.14.3.2.7'],
    ['RC2-CBC', '1.2.840.113549.3.2'],
    ['RC4', '1.2.840.113549.3.4'],
    ['an unknown OID', '1.2.3.4.5'],
  ])('refuses %s', (_name, oid) => {
    expect(() => resolveContentEncryption(oid)).toThrow(SmimeAlgorithmRefusedError);
  });

  it('marks only AEAD as authenticated', () => {
    for (const [oid, alg] of Object.entries(CONTENT_ENCRYPTION_ALLOWLIST)) {
      expect(alg.authenticated, oid).toBe(alg.cipher === 'AES-GCM');
    }
  });

  it('gates the algorithm before any private key is used', () => {
    const src = source('cms-decrypt.ts');
    const gateAt = src.indexOf('resolveContentEncryption(parts.contentEncryptionOid)');
    const keyUseAt = src.indexOf('unwrapCek(recipient, key.privateKey)');
    expect(gateAt).toBeGreaterThan(0);
    expect(keyUseAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(keyUseAt);
  });

  it('treats a failed GCM tag as a hard failure', () => {
    const src = source('cms-decrypt.ts');
    expect(/if \(!decipher\.finish\(\)\) \{[\s\S]{0,200}throw new SmimeDecryptError/.test(src)).toBe(true);
  });

  it('never emits an unauthenticated cipher', () => {
    const src = source('cms-encrypt.ts');
    expect(src).toContain("createCipher('AES-GCM'");
    expect(src).not.toContain("createCipher('AES-CBC'");
  });

  it('propagates the authentication flag into the HTML-suppression decision', () => {
    const message = source('message.ts');
    expect(message).toContain('result.suppressHtml = result.isEncrypted && !result.contentAuthenticated');
    // ...and the renderer actually honours it.
    const bodyView = readFileSync(join(__dirname, '..', '..', 'components', 'EmailBodyView.tsx'), 'utf8');
    expect(bodyView).toContain('smime?.suppressHtml');
  });
});

describe('key storage', () => {
  it('keeps private key material out of AsyncStorage', () => {
    const src = source('keystore.ts');
    // The wrapped key and the passphrase go to SecureStore; AsyncStorage only
    // ever sees the two public-metadata collections.
    expect(src).toContain('SecureStore.setItemAsync(wrappedKeyStoreKey(id)');
    expect(src).toContain('SecureStore.setItemAsync(passphraseStoreKey(id)');
    const asyncWrites = [...src.matchAll(/writeJson\((\w+)/g)].map(([, arg]) => arg);
    expect([...new Set(asyncWrites)].sort()).toEqual(['CERTS_STORAGE_KEY', 'KEYS_STORAGE_KEY']);
    expect(src).not.toMatch(/AsyncStorage\.setItem\([^)]*privateKey/);
  });

  it('wraps the key with an AEAD under a KDF', () => {
    const src = source('keystore.ts');
    expect(src).toContain("forge.pkcs5.pbkdf2");
    expect(src).toContain("createCipher('AES-GCM'");
    expect(/if \(!decipher\.finish\(\)\) throw new SmimeKeystoreError\('Wrong passphrase\.'\)/.test(src)).toBe(true);
  });
});

describe('random source', () => {
  it('fails closed instead of falling back to Math.random', () => {
    const src = code('forge.ts');
    expect(src).toContain('throw new SmimeRandomUnavailableError()');
    expect(src).not.toContain('Math.random');
    // forge's own PRNG must be replaced, not merely seeded.
    expect(src).toContain('random.getBytesSync = ');
    expect(src).toContain('random.getBytes = ');
  });
});
