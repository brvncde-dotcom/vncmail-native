/**
 * X.509 parsing for the S/MIME layer.
 *
 * Certificate identity fields are read twice on purpose: once through forge's
 * high-level `certificateFromAsn1` (for the public key, DN text and extensions)
 * and once through the byte-offset walker in `der.ts` (for the *raw* issuer and
 * subject DER). CMS matches recipients and signers on issuer DER equality, and
 * a re-encoded DN is not guaranteed to be byte-identical to the original — so
 * the raw bytes are what we keep and compare.
 */
import { forge } from './forge';
import type { ForgeCertificate, ForgeDistinguishedName, ForgePublicKey } from './forge';
import {
  bytesToHex, bytesEqual, bytesToBinary, children, contentBytes, isContext,
  octetStringValue, rawBytes, readIntegerHex, readNode, readOid, readTime,
  TAG_CLASS_UNIVERSAL, TAG_OID, type DerNode,
} from './der';
import { OID_EXT_SUBJECT_ALT_NAME, OID_EXT_SUBJECT_KEY_IDENTIFIER } from './oids';

const OID_EMAIL_ADDRESS = '1.2.840.113549.1.9.1';

export interface KeyUsageFlags {
  digitalSignature: boolean;
  keyEncipherment: boolean;
  /** True when the certificate carries no keyUsage extension (= unrestricted). */
  unrestricted: boolean;
}

export interface CertificateInfo {
  /** The certificate exactly as it arrived. Everything else is derived. */
  der: Uint8Array;
  /** Raw DER of the issuer Name — the byte string CMS matches on. */
  issuerDer: Uint8Array;
  /** Raw DER of the subject Name. */
  subjectDer: Uint8Array;
  /** Raw DER of the serialNumber INTEGER, for re-emitting IssuerAndSerialNumber. */
  serialDer: Uint8Array;
  serialHex: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  /** rfc822 addresses asserted by the certificate, lowercased and de-duplicated. */
  emailAddresses: string[];
  /** SHA-256 of the whole certificate, lowercase hex. */
  fingerprint: string;
  /** subjectKeyIdentifier extension value, hex, when present. */
  ski?: string;
  selfSigned: boolean;
  keyUsage: KeyUsageFlags;
  /** RSA public key, or undefined for a key type we cannot use (e.g. EC). */
  publicKey?: ForgePublicKey;
  publicKeyAlgorithm: string;
}

export class UnsupportedCertificateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCertificateError';
  }
}

function dnToString(dn: ForgeDistinguishedName): string {
  const parts: string[] = [];
  for (const attr of dn.attributes) {
    const name = attr.shortName ?? attr.name ?? attr.type;
    const value = typeof attr.value === 'string' ? attr.value : '';
    if (name && value) parts.push(`${name}=${value}`);
  }
  return parts.join(', ');
}

/**
 * Read the tbsCertificate positional fields as raw byte ranges.
 *   TBSCertificate ::= SEQUENCE {
 *     version [0] EXPLICIT Version DEFAULT v1,
 *     serialNumber      CertificateSerialNumber,
 *     signature         AlgorithmIdentifier,
 *     issuer            Name,
 *     validity          Validity,
 *     subject           Name,
 *     subjectPublicKeyInfo SubjectPublicKeyInfo,
 *     ... }
 */
function rawTbsFields(der: Uint8Array) {
  const cert = readNode(der);
  const certChildren = children(der, cert);
  if (certChildren.length < 1) throw new UnsupportedCertificateError('Certificate is not a SEQUENCE');
  const tbs = certChildren[0];
  const fields = children(der, tbs);
  let i = 0;
  if (fields.length > 0 && isContext(fields[0], 0)) i = 1; // explicit version
  if (fields.length < i + 6) throw new UnsupportedCertificateError('Truncated tbsCertificate');
  return {
    serial: fields[i],
    issuer: fields[i + 2],
    validity: fields[i + 3],
    subject: fields[i + 4],
  };
}

function extractSanEmails(cert: ForgeCertificate): string[] {
  const out: string[] = [];
  // forge matches a bare string against the extension *name*, not its OID, so
  // the lookup has to be by `{ id }` — passing '2.5.29.17' silently finds nothing.
  const san = cert.getExtension({ id: OID_EXT_SUBJECT_ALT_NAME } as unknown as { id: number }) as
    | { altNames?: { type: number; value?: string }[] }
    | undefined;
  for (const alt of san?.altNames ?? []) {
    // type 1 == rfc822Name. dNSName/URI/etc are deliberately ignored: an
    // address claim only counts when it is made as an email address.
    if (alt.type === 1 && alt.value) out.push(alt.value);
  }
  return out;
}

function extractSubjectEmails(cert: ForgeCertificate): string[] {
  const out: string[] = [];
  for (const attr of cert.subject.attributes) {
    if (attr.type === OID_EMAIL_ADDRESS && typeof attr.value === 'string' && attr.value) {
      out.push(attr.value);
    }
  }
  return out;
}

function extractKeyUsage(cert: ForgeCertificate): KeyUsageFlags {
  const ku = cert.getExtension('keyUsage') as
    | { digitalSignature?: boolean; keyEncipherment?: boolean }
    | undefined;
  if (!ku) return { digitalSignature: true, keyEncipherment: true, unrestricted: true };
  return {
    digitalSignature: !!ku.digitalSignature,
    keyEncipherment: !!ku.keyEncipherment,
    unrestricted: false,
  };
}

function extractSki(cert: ForgeCertificate): string | undefined {
  const ext = cert.getExtension({ id: OID_EXT_SUBJECT_KEY_IDENTIFIER } as unknown as { id: number }) as
    | { value?: string }
    | undefined;
  if (!ext?.value) return undefined;
  // forge exposes the raw extnValue bytes; the SKI is an OCTET STRING inside it.
  try {
    const inner = new Uint8Array(ext.value.length);
    for (let i = 0; i < ext.value.length; i++) inner[i] = ext.value.charCodeAt(i) & 0xff;
    const node = readNode(inner);
    return bytesToHex(octetStringValue(inner, node));
  } catch {
    return undefined;
  }
}

export function parseCertificate(der: Uint8Array): CertificateInfo {
  const raw = rawTbsFields(der);

  let cert: ForgeCertificate;
  let publicKey: ForgePublicKey | undefined;
  let publicKeyAlgorithm = 'unknown';
  try {
    cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(bytesToBinary(der))));
    publicKey = cert.publicKey as ForgePublicKey;
    publicKeyAlgorithm = 'RSA';
  } catch (err) {
    // forge only understands RSA public keys. An EC/Ed25519 certificate parses
    // far enough for us to name it in the UI but cannot be used for crypto.
    const fallback = tryParseWithoutPublicKey(der);
    if (!fallback) {
      throw new UnsupportedCertificateError(
        err instanceof Error ? `Cannot parse certificate: ${err.message}` : 'Cannot parse certificate',
      );
    }
    cert = fallback.cert;
    publicKeyAlgorithm = fallback.algorithm;
  }

  const emails = [...extractSanEmails(cert), ...extractSubjectEmails(cert)]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const validity = children(der, raw.validity);

  return {
    der,
    issuerDer: rawBytes(der, raw.issuer),
    subjectDer: rawBytes(der, raw.subject),
    serialDer: rawBytes(der, raw.serial),
    serialHex: readIntegerHex(der, raw.serial),
    subject: dnToString(cert.subject) || '(no subject)',
    issuer: dnToString(cert.issuer) || '(no issuer)',
    notBefore: validity[0] ? readTime(der, validity[0]) : '',
    notAfter: validity[1] ? readTime(der, validity[1]) : '',
    emailAddresses: [...new Set(emails)],
    fingerprint: certificateFingerprint(der),
    ski: extractSki(cert),
    selfSigned: bytesEqual(rawBytes(der, raw.issuer), rawBytes(der, raw.subject)),
    keyUsage: extractKeyUsage(cert),
    publicKey,
    publicKeyAlgorithm,
  };
}

/**
 * Parse everything except the public key, for certificates whose key type forge
 * cannot load. Enough to display the certificate and explain why it is unusable.
 */
function tryParseWithoutPublicKey(
  der: Uint8Array,
): { cert: ForgeCertificate; algorithm: string } | null {
  try {
    const certNode = readNode(der);
    const tbs = children(der, certNode)[0];
    const fields = children(der, tbs);
    const i = isContext(fields[0], 0) ? 1 : 0;
    const spki = fields[i + 6];
    const algId = children(der, spki)[0];
    const algOidNode = children(der, algId).find(
      (n) => n.tagClass === TAG_CLASS_UNIVERSAL && n.tagNumber === TAG_OID,
    );
    const algorithm = algOidNode ? namedKeyAlgorithm(readOid(der, algOidNode)) : 'unknown';
    // Re-parse via forge with the SPKI swapped for a placeholder is not worth
    // the complexity; build a minimal stand-in from the DN nodes instead.
    const issuerNode = fields[i + 2];
    const subjectNode = fields[i + 4];
    const stub = {
      subject: { attributes: decodeDn(der, subjectNode) },
      issuer: { attributes: decodeDn(der, issuerNode) },
      getExtension: () => undefined,
    } as unknown as ForgeCertificate;
    return { cert: stub, algorithm };
  } catch {
    return null;
  }
}

function namedKeyAlgorithm(algOid: string): string {
  switch (algOid) {
    case '1.2.840.113549.1.1.1': return 'RSA';
    case '1.2.840.10045.2.1': return 'EC';
    case '1.3.101.112': return 'Ed25519';
    default: return algOid;
  }
}

function decodeDn(der: Uint8Array, node: DerNode) {
  const attrs: { type: string; name?: string; shortName?: string; value: string }[] = [];
  for (const rdn of children(der, node)) {
    for (const attr of children(der, rdn)) {
      const parts = children(der, attr);
      if (parts.length < 2) continue;
      const type = readOid(der, parts[0]);
      const value = new TextDecoder().decode(contentBytes(der, parts[1]));
      attrs.push({ type, shortName: DN_SHORT_NAMES[type], value });
    }
  }
  return attrs;
}

const DN_SHORT_NAMES: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '1.2.840.113549.1.9.1': 'E',
};

export function certificateFingerprint(der: Uint8Array): string {
  const md = forge.md.sha256.create();
  md.update(bytesToBinary(der), 'raw');
  return md.digest().toHex();
}

/**
 * Does this certificate actually assert `address`?
 *
 * Used for two decisions: whether a signature's signer matches the From header,
 * and — critically — whether an auto-imported certificate may be filed under a
 * given address. Matching is exact and case-insensitive; no substring or domain
 * matching, because "close enough" here is how cert substitution gets in.
 */
export function certAssertsAddress(emailAddresses: string[], address: string | undefined): boolean {
  if (!address) return false;
  const wanted = address.trim().toLowerCase();
  if (!wanted) return false;
  return emailAddresses.some((e) => e === wanted);
}

export function isCertificateExpired(info: CertificateInfo, now = new Date()): boolean {
  const notAfter = new Date(info.notAfter);
  return Number.isFinite(notAfter.getTime()) && now > notAfter;
}

export function isCertificateNotYetValid(info: CertificateInfo, now = new Date()): boolean {
  const notBefore = new Date(info.notBefore);
  return Number.isFinite(notBefore.getTime()) && now < notBefore;
}

/** Best display label for a certificate. */
export function certificateLabel(info: CertificateInfo): string {
  return info.emailAddresses[0] ?? info.subject;
}
