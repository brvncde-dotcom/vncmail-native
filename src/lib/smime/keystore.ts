/**
 * S/MIME key and certificate storage.
 *
 * Three tiers, and the split matters:
 *
 *   1. **Private keys → expo-secure-store**, wrapped with AES-256-GCM under a
 *      PBKDF2(SHA-256) key derived from a passphrase. Never AsyncStorage. So the
 *      key material sits inside the iOS Keychain / Android Keystore *and* is
 *      passphrase-protected: an attacker needs both the device secret store and
 *      the passphrase.
 *   2. **Public metadata → AsyncStorage** (`smime:keys:v1`, `smime:certs:v1`).
 *      Certificates, addresses, validity dates, fingerprints. All of it is
 *      already public by definition; keeping it out of SecureStore avoids
 *      pushing kilobytes of certificate DER through the Keychain.
 *   3. **Unlocked keys → memory only**, for the lifetime of the app process.
 *
 * The PBKDF2 iteration count is much lower than the webmail plugin's 600 000, on
 * purpose and with a measurement behind it. In the browser the wrapped blob sits
 * in IndexedDB where any local attacker can read it, so the KDF is the only
 * barrier. Here the blob is already inside the platform keystore, so the KDF is
 * defence in depth against someone who has already defeated Keychain/Keystore.
 * Measured on the Android emulator (Hermes, no JIT, pure-JS SHA-256): 100 000
 * rounds cost 8-16 s per unlock, which is long enough that users would simply
 * leave keys unlocked. 50 000 keeps it in the low seconds. The count is stored
 * per key, so raising it later is a one-line change that does not orphan any
 * key already imported.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { forge, randomBytes } from './forge';
import type { ForgePrivateKey } from './forge';
import { base64ToBytes, binaryToBytes, bytesToBase64, bytesToBinary } from './der';
import { parseCertificate, type CertificateInfo } from './certificate';
import { privateKeyFromPem, type ImportedIdentity } from './pkcs12';

const KEYS_STORAGE_KEY = 'smime:keys:v1';
const CERTS_STORAGE_KEY = 'smime:certs:v1';
const PBKDF2_ITERATIONS = 50_000;

// SecureStore keys accept letters, digits, '.', '-' and '_' only (see the note
// in api/jmap-client.ts). Ids are hex, so they are always safe.
const wrappedKeyStoreKey = (id: string) => `smime.key.${id}`;
const passphraseStoreKey = (id: string) => `smime.pass.${id}`;

export interface StoredKeyRecord {
  id: string;
  /** Primary address this identity signs/decrypts for. */
  email: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  fingerprint: string;
  /** base64 DER of the leaf certificate. */
  certificate: string;
  /** base64 DER of any intermediates shipped with it. */
  chain: string[];
  /** All addresses the certificate asserts. */
  addresses: string[];
  importedAt: string;
  friendlyName?: string;
}

export interface StoredCertRecord {
  id: string;
  email: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  fingerprint: string;
  certificate: string;
  /** How it got here — shown in the UI and used by the auto-import gate. */
  source: 'manual' | 'signed-email';
  addedAt: string;
}

interface WrappedKey {
  v: 1;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export class SmimeKeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmimeKeystoreError';
  }
}

// ── in-memory unlocked keys ────────────────────────────────────────────
const unlockedKeys = new Map<string, ForgePrivateKey>();

export function isUnlocked(id: string): boolean {
  return unlockedKeys.has(id);
}

export function unlockedKeyIds(): string[] {
  return [...unlockedKeys.keys()];
}

export function getUnlockedKey(id: string): ForgePrivateKey | undefined {
  return unlockedKeys.get(id);
}

/**
 * Drop every unlocked key from memory. Called on logout and account switch —
 * a signed-out session must not be able to decrypt the previous user's mail.
 */
export function lockAll(): void {
  unlockedKeys.clear();
}

// ── crypto helpers ────────────────────────────────────────────────────

function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): string {
  return forge.pkcs5.pbkdf2(passphrase, bytesToBinary(salt), iterations, 32, forge.md.sha256.create());
}

function wrapPrivateKey(pem: string, passphrase: string): WrappedKey {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const cipher = forge.cipher.createCipher('AES-GCM', key);
  cipher.start({ iv: bytesToBinary(iv), tagLength: 128 });
  cipher.update(forge.util.createBuffer(pem, 'utf8'));
  if (!cipher.finish()) throw new SmimeKeystoreError('Could not protect the private key');
  return {
    v: 1,
    kdf: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(binaryToBytes(cipher.output.getBytes())),
    tag: bytesToBase64(binaryToBytes(cipher.mode.tag.getBytes())),
  };
}

function unwrapPrivateKey(wrapped: WrappedKey, passphrase: string): string {
  if (wrapped.v !== 1 || wrapped.kdf !== 'pbkdf2-sha256') {
    throw new SmimeKeystoreError('Stored key uses an unsupported format');
  }
  const key = deriveKey(passphrase, base64ToBytes(wrapped.salt), wrapped.iterations);
  const decipher = forge.cipher.createDecipher('AES-GCM', key);
  decipher.start({
    iv: bytesToBinary(base64ToBytes(wrapped.iv)),
    tagLength: 128,
    tag: forge.util.createBuffer(bytesToBinary(base64ToBytes(wrapped.tag))),
  });
  decipher.update(forge.util.createBuffer(bytesToBinary(base64ToBytes(wrapped.ciphertext))));
  // A GCM tag failure here is a wrong passphrase (or a tampered blob). Either
  // way there is nothing to hand back.
  if (!decipher.finish()) throw new SmimeKeystoreError('Wrong passphrase.');
  return decipher.output.toString();
}

// ── record storage ─────────────────────────────────────────────────────

async function readJson<T>(storageKey: string): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJson<T>(storageKey: string, value: T[]): Promise<void> {
  await AsyncStorage.setItem(storageKey, JSON.stringify(value));
}

export async function listKeyRecords(): Promise<StoredKeyRecord[]> {
  return readJson<StoredKeyRecord>(KEYS_STORAGE_KEY);
}

export async function listCertRecords(): Promise<StoredCertRecord[]> {
  return readJson<StoredCertRecord>(CERTS_STORAGE_KEY);
}

function recordId(fingerprint: string): string {
  return fingerprint.slice(0, 32);
}

export interface ImportKeyOptions {
  identity: ImportedIdentity;
  /** Passphrase protecting the stored key — normally the .p12's own. */
  passphrase: string;
  /** Persist the passphrase in SecureStore so unlock is automatic. */
  remember: boolean;
}

export async function importKeyRecord(options: ImportKeyOptions): Promise<StoredKeyRecord> {
  const { identity, passphrase, remember } = options;
  const cert = identity.certificate;
  if (!cert.publicKey) {
    throw new SmimeKeystoreError(
      `This certificate uses an unsupported key type (${cert.publicKeyAlgorithm}). Only RSA is supported.`,
    );
  }

  const id = recordId(cert.fingerprint);
  const wrapped = wrapPrivateKey(identity.privateKeyPem, passphrase);
  await SecureStore.setItemAsync(wrappedKeyStoreKey(id), JSON.stringify(wrapped));
  if (remember) {
    await SecureStore.setItemAsync(passphraseStoreKey(id), passphrase);
  } else {
    await SecureStore.deleteItemAsync(passphraseStoreKey(id)).catch(() => {});
  }

  const record: StoredKeyRecord = {
    id,
    email: cert.emailAddresses[0] ?? '',
    subject: cert.subject,
    issuer: cert.issuer,
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    fingerprint: cert.fingerprint,
    certificate: bytesToBase64(cert.der),
    chain: identity.chain.map((c) => bytesToBase64(c.der)),
    addresses: cert.emailAddresses,
    importedAt: new Date().toISOString(),
    friendlyName: identity.friendlyName,
  };

  const records = await listKeyRecords();
  const next = [...records.filter((r) => r.id !== id), record];
  await writeJson(KEYS_STORAGE_KEY, next);

  // Importing implies possession, so the key starts unlocked for this session.
  unlockedKeys.set(id, privateKeyFromPem(identity.privateKeyPem));
  return record;
}

export async function deleteKeyRecord(id: string): Promise<void> {
  unlockedKeys.delete(id);
  await SecureStore.deleteItemAsync(wrappedKeyStoreKey(id)).catch(() => {});
  await SecureStore.deleteItemAsync(passphraseStoreKey(id)).catch(() => {});
  const records = await listKeyRecords();
  await writeJson(KEYS_STORAGE_KEY, records.filter((r) => r.id !== id));
}

/** True when the passphrase is stored and the key can unlock without a prompt. */
export async function hasStoredPassphrase(id: string): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(passphraseStoreKey(id))) != null;
  } catch {
    return false;
  }
}

/**
 * Unlock a key. With no passphrase argument, tries the one saved in
 * SecureStore; returns false when there is none (the caller should prompt).
 */
export async function unlockKey(id: string, passphrase?: string): Promise<boolean> {
  if (unlockedKeys.has(id)) return true;

  const raw = await SecureStore.getItemAsync(wrappedKeyStoreKey(id));
  if (!raw) throw new SmimeKeystoreError('The private key for this certificate is missing.');

  let pass = passphrase;
  if (pass == null) {
    pass = (await SecureStore.getItemAsync(passphraseStoreKey(id))) ?? undefined;
    if (pass == null) return false;
  }

  const pem = unwrapPrivateKey(JSON.parse(raw) as WrappedKey, pass);
  unlockedKeys.set(id, privateKeyFromPem(pem));
  return true;
}

/** Forget a key for this session, and stop it auto-unlocking next time. */
export async function lockKey(id: string): Promise<void> {
  unlockedKeys.delete(id);
  await SecureStore.deleteItemAsync(passphraseStoreKey(id)).catch(() => {});
}

/**
 * Save (or forget) the passphrase for every key. Called when the user toggles
 * "Remember unlocked keys": turning it off must actively remove what was
 * already stored, or the setting would be a lie for existing keys.
 */
export async function applyRememberUnlocked(remember: boolean): Promise<void> {
  if (remember) return; // nothing to add — passphrases are captured at unlock time
  const records = await listKeyRecords();
  await Promise.all(
    records.map((r) => SecureStore.deleteItemAsync(passphraseStoreKey(r.id)).catch(() => {})),
  );
}

/** Remember the passphrase for a key that is already unlocked. */
export async function rememberPassphrase(id: string, passphrase: string): Promise<void> {
  await SecureStore.setItemAsync(passphraseStoreKey(id), passphrase);
}

/** Unlock every key that has a stored passphrase. Called at app start. */
export async function autoUnlockAll(): Promise<string[]> {
  const records = await listKeyRecords();
  const unlockedNow: string[] = [];
  for (const record of records) {
    try {
      if (await unlockKey(record.id)) unlockedNow.push(record.id);
    } catch {
      /* a key we cannot unlock stays locked */
    }
  }
  return unlockedNow;
}

// ── recipient certificates ────────────────────────────────────────────

export async function saveCertRecord(
  cert: CertificateInfo,
  email: string,
  source: StoredCertRecord['source'],
): Promise<StoredCertRecord> {
  const record: StoredCertRecord = {
    id: recordId(cert.fingerprint),
    email: email.trim().toLowerCase(),
    subject: cert.subject,
    issuer: cert.issuer,
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    fingerprint: cert.fingerprint,
    certificate: bytesToBase64(cert.der),
    source,
    addedAt: new Date().toISOString(),
  };
  const records = await listCertRecords();
  await writeJson(CERTS_STORAGE_KEY, [...records.filter((r) => r.id !== record.id), record]);
  return record;
}

export async function deleteCertRecord(id: string): Promise<void> {
  const records = await listCertRecords();
  await writeJson(CERTS_STORAGE_KEY, records.filter((r) => r.id !== id));
}

/**
 * Best encryption certificate for an address, preferring a manually imported
 * one over anything harvested from mail, and a longer-lived one over a
 * shorter-lived one. Expired certificates are never returned.
 */
export async function findCertificateFor(address: string): Promise<CertificateInfo | undefined> {
  const wanted = address.trim().toLowerCase();
  const records = await listCertRecords();
  const now = Date.now();
  const candidates = records
    .filter((r) => r.email === wanted)
    .filter((r) => {
      const notAfter = new Date(r.notAfter).getTime();
      return !Number.isFinite(notAfter) || notAfter > now;
    })
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === 'manual' ? -1 : 1;
      return new Date(b.notAfter).getTime() - new Date(a.notAfter).getTime();
    });

  // Own certificates count too: encrypting to yourself is how the Sent copy
  // stays readable, and a user with an imported identity should not have to
  // separately import their own public certificate.
  if (candidates.length === 0) {
    const keys = await listKeyRecords();
    const own = keys.find((k) => k.addresses.includes(wanted));
    if (own) return safeParse(own.certificate);
    return undefined;
  }
  return safeParse(candidates[0].certificate);
}

export function safeParse(base64Der: string): CertificateInfo | undefined {
  try {
    return parseCertificate(base64ToBytes(base64Der));
  } catch {
    return undefined;
  }
}

/** Key records paired with their parsed certificates. */
export async function loadKeyCertificates(): Promise<
  { record: StoredKeyRecord; certificate: CertificateInfo }[]
> {
  const records = await listKeyRecords();
  const out: { record: StoredKeyRecord; certificate: CertificateInfo }[] = [];
  for (const record of records) {
    const certificate = safeParse(record.certificate);
    if (certificate) out.push({ record, certificate });
  }
  return out;
}

/** The identity to sign with for a given From address. */
export async function findSigningIdentity(fromAddress: string): Promise<
  { record: StoredKeyRecord; certificate: CertificateInfo; chain: CertificateInfo[] } | undefined
> {
  const wanted = fromAddress.trim().toLowerCase();
  const pairs = await loadKeyCertificates();
  const now = Date.now();
  const match = pairs
    .filter((p) => p.record.addresses.includes(wanted))
    .filter((p) => new Date(p.record.notAfter).getTime() > now)
    .sort((a, b) => new Date(b.record.notAfter).getTime() - new Date(a.record.notAfter).getTime())[0];
  if (!match) return undefined;
  return {
    record: match.record,
    certificate: match.certificate,
    chain: match.record.chain.map(safeParse).filter((c): c is CertificateInfo => !!c),
  };
}
