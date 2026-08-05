/**
 * CMS EnvelopedData construction (RFC 5652 §6).
 *
 * Defaults to AES-256-GCM with RSA-OAEP(SHA-256) key transport. Two reasons:
 *
 * 1. GCM is authenticated, so the recipient's render path can treat the
 *    plaintext as trusted HTML. Everything we send is therefore immune to the
 *    EFAIL ciphertext-malleability class by construction, rather than relying on
 *    the recipient's mitigations.
 * 2. It is wire-compatible with the VNCmail+ webmail S/MIME plugin, which
 *    encrypts through pkijs. pkijs writes the GCM nonce as a bare 16-byte
 *    OCTET STRING in `algorithmParams` and appends the 128-bit tag to the
 *    ciphertext (verified against `pkijs/build/index.js` EnvelopedData.encrypt),
 *    so this module emits exactly that shape. The alternative RFC 5084
 *    `GCMParameters` SEQUENCE is accepted on the *decrypt* side for senders that
 *    follow the letter of the spec.
 */
import { forge } from './forge';
import { randomBytes } from './forge';
import {
  algorithmIdentifier, binaryToBytes, bytesToBinary, ctx, encodeDer, integerFromNumber,
  octetString, oid, rawDer, seq, setOf,
} from './der';
import type { CertificateInfo } from './certificate';
import {
  CONTENT_ENCRYPTION_ALLOWLIST, OID_AES_128_GCM, OID_AES_256_GCM, OID_DATA,
  OID_ENVELOPED_DATA, OID_MGF1, OID_RSAES_OAEP, OID_SHA256,
} from './oids';

export class SmimeEncryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmimeEncryptError';
  }
}

export interface EncryptInput {
  /** The MIME entity to encrypt. */
  content: Uint8Array;
  /**
   * Certificates to encrypt to. The sender's own certificate must be included
   * by the caller so the copy in Sent is readable.
   */
  recipients: CertificateInfo[];
  keyLength?: 128 | 256;
}

/** DER-encoded `ContentInfo { envelopedData }`. */
export function buildEnvelopedData(input: EncryptInput): Uint8Array {
  const unique = deduplicate(input.recipients);
  if (unique.length === 0) throw new SmimeEncryptError('No recipient certificates provided');

  const usable = unique.filter((c) => !!c.publicKey);
  if (usable.length === 0) {
    throw new SmimeEncryptError(
      'None of the recipient certificates use a supported key type (RSA is required).',
    );
  }

  const contentOid = input.keyLength === 128 ? OID_AES_128_GCM : OID_AES_256_GCM;
  const alg = CONTENT_ENCRYPTION_ALLOWLIST[contentOid];

  // Content-encryption key and nonce come from the platform CSPRNG; `forge.ts`
  // throws rather than degrading if none is reachable.
  const cek = randomBytes(alg.keyLength);
  const nonce = randomBytes(16);

  const cipher = forge.cipher.createCipher('AES-GCM', bytesToBinary(cek));
  cipher.start({ iv: bytesToBinary(nonce), tagLength: 128 });
  cipher.update(forge.util.createBuffer(bytesToBinary(input.content), 'raw'));
  if (!cipher.finish()) throw new SmimeEncryptError('Content encryption failed');
  const ciphertext = binaryToBytes(cipher.output.getBytes() + cipher.mode.tag.getBytes());

  const recipientInfos = usable.map((cert) => buildKeyTransRecipientInfo(cert, cek));

  const envelopedData = seq([
    integerFromNumber(0), // version 0: all recipientInfos are KeyTransRecipientInfo v0
    setOf(recipientInfos),
    seq([
      oid(OID_DATA),
      seq([oid(contentOid), octetString(nonce)]),
      // [0] IMPLICIT encryptedContent
      forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, false, bytesToBinary(ciphertext)),
    ]),
  ]);

  return encodeDer(seq([oid(OID_ENVELOPED_DATA), ctx(0, [envelopedData])]));
}

/** Certificates whose key we cannot encrypt to, for a clear UI message. */
export function unusableRecipients(recipients: CertificateInfo[]): CertificateInfo[] {
  return recipients.filter((c) => !c.publicKey);
}

function buildKeyTransRecipientInfo(cert: CertificateInfo, cek: Uint8Array) {
  const publicKey = cert.publicKey!;
  let wrapped: string;
  try {
    wrapped = publicKey.encrypt(bytesToBinary(cek), 'RSA-OAEP', {
      md: forge.md.sha256.create(),
      mgf1: { md: forge.md.sha256.create() },
    });
  } catch (err) {
    throw new SmimeEncryptError(
      `Could not encrypt to ${cert.emailAddresses[0] ?? cert.subject}: `
      + (err instanceof Error ? err.message : String(err)),
    );
  }

  // RSAES-OAEP-params: hashAlgorithm [0], maskGenAlgorithm [1]; pSourceFunc
  // omitted (default empty label), which is what every S/MIME peer expects.
  const oaepParams = seq([
    ctx(0, [algorithmIdentifier(OID_SHA256)]),
    ctx(1, [algorithmIdentifier(OID_MGF1, algorithmIdentifier(OID_SHA256))]),
  ]);

  return seq([
    integerFromNumber(0), // version
    seq([rawDer(cert.issuerDer), rawDer(cert.serialDer)]),
    seq([oid(OID_RSAES_OAEP), oaepParams]),
    octetString(binaryToBytes(wrapped)),
  ]);
}

function deduplicate(certs: CertificateInfo[]): CertificateInfo[] {
  const seen = new Set<string>();
  const out: CertificateInfo[] = [];
  for (const cert of certs) {
    if (seen.has(cert.fingerprint)) continue;
    seen.add(cert.fingerprint);
    out.push(cert);
  }
  return out;
}
