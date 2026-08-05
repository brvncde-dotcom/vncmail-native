/**
 * The one and only entry point for node-forge in this app.
 *
 * Why a wrapper instead of importing `node-forge` directly:
 *
 * node-forge ships its own Fortuna-style PRNG. When it cannot reach a platform
 * CSPRNG it seeds that PRNG from `Math.random()`, `Date.now()` and (in a
 * browser) some DOM noise, and then keeps working without complaint. React
 * Native's Hermes runtime exposes no `crypto.getRandomValues`, so left alone
 * forge would generate CMS content-encryption keys, GCM/CBC IVs and OAEP
 * padding from a non-cryptographic source — silently, on every device.
 *
 * Routing every forge import through this module guarantees two things:
 *   1. `forge.random` is replaced with the platform CSPRNG *before* any crypto
 *      call can happen (module side effect, not an init() the caller may skip).
 *   2. We fail closed. If no CSPRNG is reachable, `randomBytes` throws instead
 *      of falling back to `Math.random()`. An S/MIME feature that cannot get
 *      real entropy must refuse to sign or encrypt, not produce something that
 *      merely looks encrypted.
 */
import forgeLib from 'node-forge';
import type { pki as ForgePki, pkcs12 as ForgePkcs12 } from 'node-forge';

// The @types/node-forge namespaces are not reachable through the default import,
// so the handful of forge types we pass around get concrete aliases here.
export type ForgePrivateKey = ForgePki.rsa.PrivateKey;
export type ForgePublicKey = ForgePki.rsa.PublicKey;
export type ForgeCertificate = ForgePki.Certificate;
export type ForgeDistinguishedName = ForgePki.Certificate['subject'];
export type ForgePkcs12Pfx = ForgePkcs12.Pkcs12Pfx;
export type ForgeKeyPair = ForgePki.rsa.KeyPair;

export class SmimeRandomUnavailableError extends Error {
  constructor() {
    super(
      'No cryptographically secure random source is available on this device. '
      + 'S/MIME operations are disabled.',
    );
    this.name = 'SmimeRandomUnavailableError';
  }
}

export type RandomSourceName = 'expo-crypto' | 'global-crypto' | 'none';

interface RandomSource {
  name: RandomSourceName;
  fill: (target: Uint8Array) => void;
}

// expo-crypto's getRandomValues mirrors the WebCrypto quota (65 536 bytes per
// call). We chunk well under it so a large request can never trip the limit.
const FILL_CHUNK = 4096;

let cached: RandomSource | null | undefined;

function probe(fill: (t: Uint8Array) => void): boolean {
  // A source that throws, returns nothing, or hands back all-zero bytes is not
  // a source. The zero check is deliberately cheap: it catches a stubbed or
  // unlinked native module, which is the realistic failure here.
  try {
    const sample = new Uint8Array(16);
    fill(sample);
    return sample.some((b) => b !== 0);
  } catch {
    return false;
  }
}

function resolveSource(): RandomSource | null {
  if (cached !== undefined) return cached;

  // Preferred: the platform CSPRNG (SecRandomCopyBytes on iOS,
  // java.security.SecureRandom on Android) via expo-crypto. Required lazily so
  // a build without the native module linked degrades to the check below
  // rather than crashing at import time.
  try {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const expoCrypto = require('expo-crypto') as typeof import('expo-crypto');
    if (typeof expoCrypto?.getRandomValues === 'function') {
      const fill = (target: Uint8Array) => {
        for (let offset = 0; offset < target.length; offset += FILL_CHUNK) {
          const view = target.subarray(offset, Math.min(offset + FILL_CHUNK, target.length));
          expoCrypto.getRandomValues(view);
        }
      };
      if (probe(fill)) {
        cached = { name: 'expo-crypto', fill };
        return cached;
      }
    }
  } catch {
    /* module missing or not linked — fall through */
  }

  // Web / dev-server runtimes, and any future RN release that ships WebCrypto.
  const g = globalThis as unknown as {
    crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
  };
  const getRandomValues = g.crypto?.getRandomValues;
  if (typeof getRandomValues === 'function') {
    const fill = (target: Uint8Array) => {
      for (let offset = 0; offset < target.length; offset += FILL_CHUNK) {
        getRandomValues.call(g.crypto, target.subarray(offset, Math.min(offset + FILL_CHUNK, target.length)));
      }
    };
    if (probe(fill)) {
      cached = { name: 'global-crypto', fill };
      return cached;
    }
  }

  cached = null;
  return null;
}

/** Name of the CSPRNG actually in use. Surfaced by the on-device self-test. */
export function randomSourceName(): RandomSourceName {
  return resolveSource()?.name ?? 'none';
}

/** True when S/MIME can safely produce key material. */
export function hasSecureRandom(): boolean {
  return resolveSource() !== null;
}

/** CSPRNG bytes, or throw. Never falls back to a weak source. */
export function randomBytes(count: number): Uint8Array {
  const source = resolveSource();
  if (!source) throw new SmimeRandomUnavailableError();
  const out = new Uint8Array(count);
  if (count > 0) source.fill(out);
  return out;
}

/** CSPRNG bytes as a forge "binary string" (one byte per char code). */
export function randomBinary(count: number): string {
  const bytes = randomBytes(count);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

// ── Replace forge's PRNG ──────────────────────────────────────────────
//
// Everything inside forge that needs randomness (PKCS#12 salts, OAEP seeds,
// RSA key generation, PBKDF2 salts) goes through `forge.random.getBytesSync` or
// `forge.random.getBytes`. Overriding both redirects the whole library at the
// platform CSPRNG and makes the weak-seed path unreachable.
{
  const random = forgeLib.random as unknown as {
    getBytesSync: (count: number) => string;
    getBytes: (count: number, cb?: (err: Error | null, bytes: string) => void) => string | undefined;
  };
  random.getBytesSync = (count: number) => randomBinary(count);
  random.getBytes = (count, cb) => {
    // Deliberately not try/caught: a missing CSPRNG must propagate, not turn
    // into a callback that hands back an empty string forge would happily use.
    const bytes = randomBinary(count);
    if (cb) {
      cb(null, bytes);
      return undefined;
    }
    return bytes;
  };
}

export const forge = forgeLib;
export default forgeLib;
