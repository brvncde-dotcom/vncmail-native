/**
 * PKCS#12 (.p12 / .pfx) import.
 *
 * Handles both shapes users actually have: OpenSSL 3 defaults (PBES2 with
 * PBKDF2 + AES-256-CBC) and the legacy pre-3.0 / Windows export
 * (pbeWithSHAAnd3-KeyTripleDES-CBC, RC2-40 for the cert bag).
 *
 * The key↔certificate pairing is done by comparing RSA moduli rather than by
 * bag order. A .p12 that carries an intermediate and a root alongside the leaf
 * is completely normal, and picking the wrong one produces a keypair that
 * "imports fine" and then silently fails to decrypt anything.
 */
import { forge } from './forge';
import type { ForgeCertificate, ForgePkcs12Pfx, ForgePrivateKey } from './forge';
import { binaryToBytes, bytesToBinary } from './der';
import { parseCertificate, type CertificateInfo } from './certificate';

export class Pkcs12ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Pkcs12ImportError';
  }
}

export interface ImportedIdentity {
  /** PKCS#8 PEM of the private key. Only ever handed to secure storage. */
  privateKeyPem: string;
  /** The leaf certificate matching the private key. */
  certificate: CertificateInfo;
  /** Any other certificates in the file (intermediates / root), in file order. */
  chain: CertificateInfo[];
  /** friendlyName from the file, when present. */
  friendlyName?: string;
}

interface Bag {
  key?: ForgePrivateKey | null;
  cert?: ForgeCertificate | null;
  attributes?: Record<string, string[] | undefined>;
}

function collectBags(p12: ForgePkcs12Pfx, bagType: string): Bag[] {
  const found = p12.getBags({ bagType }) as Record<string, Bag[] | undefined>;
  return found[bagType] ?? [];
}

/**
 * Import a PKCS#12 file.
 *
 * @param bytes      raw file contents
 * @param passphrase the file's passphrase (an empty string is a legal value)
 */
export function importPkcs12(bytes: Uint8Array, passphrase: string): ImportedIdentity {
  if (bytes.length === 0) throw new Pkcs12ImportError('The selected file is empty.');
  if (bytes[0] !== 0x30) {
    throw new Pkcs12ImportError(
      'This does not look like a PKCS#12 file. Export your certificate as .p12 or .pfx and try again.',
    );
  }

  let p12: ForgePkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(bytesToBinary(bytes)));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // forge reports a bad passphrase as a MAC/decrypt failure. Say the useful
    // thing rather than surfacing "PKCS#12 MAC could not be verified".
    if (/mac|invalid password|Cannot read|decrypt/i.test(message)) {
      throw new Pkcs12ImportError('Wrong passphrase, or the file is not a valid PKCS#12 file.');
    }
    throw new Pkcs12ImportError(`Could not read the PKCS#12 file: ${message}`);
  }

  const keyBags = [
    ...collectBags(p12, forge.pki.oids.pkcs8ShroudedKeyBag),
    ...collectBags(p12, forge.pki.oids.keyBag),
  ];
  const certBags = collectBags(p12, forge.pki.oids.certBag);

  const privateKey = keyBags.find((b) => b.key)?.key;
  if (!privateKey) {
    throw new Pkcs12ImportError(
      'The file contains no private key. Export the certificate together with its private key.',
    );
  }
  if (!privateKey.n) {
    throw new Pkcs12ImportError('Only RSA private keys are supported.');
  }
  if (certBags.length === 0) {
    throw new Pkcs12ImportError('The file contains no certificate.');
  }

  const parsed: { info: CertificateInfo; friendlyName?: string }[] = [];
  for (const bag of certBags) {
    if (!bag.cert) continue;
    try {
      const der = binaryToBytes(forge.asn1.toDer(forge.pki.certificateToAsn1(bag.cert)).getBytes());
      parsed.push({ info: parseCertificate(der), friendlyName: bag.attributes?.friendlyName?.[0] });
    } catch {
      /* skip a certificate we cannot parse rather than failing the whole import */
    }
  }
  if (parsed.length === 0) {
    throw new Pkcs12ImportError('None of the certificates in the file could be parsed.');
  }

  // Pair by modulus, not by position.
  const keyModulus = privateKey.n.toString(16);
  const leafIndex = parsed.findIndex((p) => p.info.publicKey?.n?.toString(16) === keyModulus);
  if (leafIndex === -1) {
    throw new Pkcs12ImportError(
      'The private key in this file does not match any of its certificates.',
    );
  }

  const leaf = parsed[leafIndex];
  const chain = parsed.filter((_, i) => i !== leafIndex).map((p) => p.info);

  let privateKeyPem: string;
  try {
    privateKeyPem = forge.pki.privateKeyInfoToPem(
      forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(privateKey)),
    );
  } catch (err) {
    throw new Pkcs12ImportError(
      `Could not serialise the private key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    privateKeyPem,
    certificate: leaf.info,
    chain,
    friendlyName: leaf.friendlyName,
  };
}

/** Load a private key previously serialised by {@link importPkcs12}. */
export function privateKeyFromPem(pem: string): ForgePrivateKey {
  const key = forge.pki.privateKeyFromPem(pem);
  if (!key?.n) throw new Error('Stored private key is not a usable RSA key');
  return key;
}

/** Parse a standalone certificate file (.crt/.cer/.pem/.der) for the recipient store. */
export function parseCertificateFile(bytes: Uint8Array): CertificateInfo[] {
  // DER: a bare certificate starts with a SEQUENCE tag.
  if (bytes.length > 0 && bytes[0] === 0x30) {
    return [parseCertificate(bytes)];
  }
  const text = new TextDecoder().decode(bytes);
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks?.length) {
    throw new Pkcs12ImportError(
      'No certificate found. Expected a DER or PEM encoded X.509 certificate.',
    );
  }
  const out: CertificateInfo[] = [];
  for (const block of blocks) {
    const body = block
      .replace('-----BEGIN CERTIFICATE-----', '')
      .replace('-----END CERTIFICATE-----', '')
      .replace(/\s+/g, '');
    out.push(parseCertificate(binaryToBytes(forge.util.decode64(body))));
  }
  return out;
}
