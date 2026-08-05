/**
 * The S/MIME self-test.
 *
 * This runs the *real* pipeline — generate an RSA identity, export it as a
 * PKCS#12, import it back through `importPkcs12`, sign, verify, encrypt, decrypt,
 * and try to break each of those — and is deliberately runtime-agnostic so the
 * identical assertions execute in two places:
 *
 *   • Node, from `__tests__/smime-roundtrip.test.ts`
 *   • the React Native runtime, from Settings → S/MIME → "Run self-test"
 *
 * The second one is the point. Crypto libraries that pass in Node routinely fail
 * on Hermes (missing WebCrypto, no Buffer, different TypedArray behaviour, JIT-
 * free bignum performance), so "the tests are green" says nothing about the
 * device. Nothing here is fixture data baked into the bundle: no test key
 * material ships with the app, and the key generation itself exercises the
 * platform CSPRNG.
 */
import { forge, randomBytes, randomSourceName, hasSecureRandom } from './forge';
import {
  algorithmIdentifier, base64ToBytes, binaryToBytes, bytesToBase64, bytesToBinary,
  bytesToHex, bytesToUtf8, concatBytes, ctx, encodeDer, integerFromNumber, octetString,
  oid, rawDer, seq, setOf, utf8ToBytes,
} from './der';
import { parseCertificate, certAssertsAddress, type CertificateInfo } from './certificate';
import { importPkcs12, Pkcs12ImportError, privateKeyFromPem } from './pkcs12';
import { buildSignedData } from './cms-sign';
import { verifySignedData } from './cms-verify';
import { buildEnvelopedData } from './cms-encrypt';
import {
  decryptEnvelopedData, SmimeDecryptError, SmimeNoKeyError, type UnlockedKey,
} from './cms-decrypt';
import { decideAutoImport } from './autoimport';
import { buildOutgoingSmime, generateMessageId } from './send';
import { processSmimeMessage } from './message';
import {
  encodeHeaderValue, formatAddress, formatHeader, stripCrlf, buildInnerMime, makeBoundary,
} from './mime-builder';
import { parseMime, flattenMime, parseContentTypeHeader } from './mime-parse';
import {
  OID_DATA, OID_ENVELOPED_DATA, resolveContentEncryption, SmimeAlgorithmRefusedError,
} from './oids';
import type { StoredCertRecord } from './keystore';
import type { ForgeKeyPair, ForgePrivateKey } from './forge';

export interface SelfTestAssertion {
  group: string;
  name: string;
  passed: boolean;
  detail?: string;
}

export interface SelfTestReport {
  randomSource: string;
  passed: number;
  failed: number;
  durationMs: number;
  assertions: SelfTestAssertion[];
  fatal?: string;
}

const ALICE = 'smime-test@sandbox.vnc.de';
const BOB = 'smime-other@sandbox.vnc.de';

class Recorder {
  assertions: SelfTestAssertion[] = [];
  group = 'setup';

  section(name: string) {
    this.group = name;
  }

  check(name: string, condition: unknown, detail?: string) {
    this.assertions.push({ group: this.group, name, passed: !!condition, detail: condition ? undefined : detail });
  }

  equal(name: string, actual: unknown, expected: unknown) {
    const passed = actual === expected;
    this.assertions.push({
      group: this.group,
      name,
      passed,
      detail: passed ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
    });
  }

  throws(name: string, fn: () => unknown, predicate?: (err: unknown) => boolean) {
    try {
      fn();
      this.check(name, false, 'did not throw');
    } catch (err) {
      this.check(name, predicate ? predicate(err) : true, err instanceof Error ? err.message : String(err));
    }
  }
}

interface TestIdentity {
  privateKey: ForgePrivateKey;
  certificate: CertificateInfo;
  chain: CertificateInfo[];
  p12: Uint8Array;
}

/** Issue a certificate. `issuer` undefined ⇒ self-signed. */
function issueCertificate(options: {
  subjectCn: string;
  email?: string;
  keys: ForgeKeyPair;
  issuer?: { cn: string; key: ForgePrivateKey };
  serial: string;
  years?: number;
}): Uint8Array {
  const cert = forge.pki.createCertificate();
  cert.publicKey = options.keys.publicKey;
  cert.serialNumber = options.serial;
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + (options.years ?? 2) * 365 * 24 * 3600 * 1000);
  cert.setSubject([{ name: 'commonName', value: options.subjectCn }, { name: 'countryName', value: 'CH' }]);
  cert.setIssuer(
    options.issuer
      ? [{ name: 'commonName', value: options.issuer.cn }, { name: 'countryName', value: 'CH' }]
      : [{ name: 'commonName', value: options.subjectCn }, { name: 'countryName', value: 'CH' }],
  );
  const extensions: Record<string, unknown>[] = [
    { name: 'basicConstraints', cA: !options.email },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: !options.email },
  ];
  if (options.email) {
    extensions.push({ name: 'subjectAltName', altNames: [{ type: 1, value: options.email }] });
    extensions.push({ name: 'extKeyUsage', emailProtection: true });
  }
  cert.setExtensions(extensions as Parameters<typeof cert.setExtensions>[0]);
  cert.sign(options.issuer ? options.issuer.key : options.keys.privateKey, forge.md.sha256.create());
  return binaryToBytes(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
}

function toPkcs12(
  privateKey: ForgePrivateKey,
  certs: Uint8Array[],
  passphrase: string,
): Uint8Array {
  const forgeCerts = certs.map((der) =>
    forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(bytesToBinary(der)))),
  );
  const asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, forgeCerts, passphrase, {
    algorithm: '3des',
    friendlyName: 'Self-test identity',
  });
  return binaryToBytes(forge.asn1.toDer(asn1).getBytes());
}

/**
 * Build a CBC-encrypted EnvelopedData, or one using a refused legacy cipher.
 * Only the self-test does this: the shipping encrypt path is AEAD-only, so
 * reading Outlook/Thunderbird CBC mail and refusing 3DES both need a sender we
 * control in order to be tested at all.
 */
function buildLegacyEnvelope(options: {
  content: Uint8Array;
  recipient: CertificateInfo;
  contentOid: string;
  cipher: 'AES-CBC' | 'none';
  keyLength: number;
}): Uint8Array {
  const cek = randomBytes(options.keyLength);
  const iv = randomBytes(16);
  let ciphertext: Uint8Array;
  if (options.cipher === 'AES-CBC') {
    const c = forge.cipher.createCipher('AES-CBC', bytesToBinary(cek));
    c.start({ iv: bytesToBinary(iv) });
    c.update(forge.util.createBuffer(bytesToBinary(options.content), 'raw'));
    c.finish();
    ciphertext = binaryToBytes(c.output.getBytes());
  } else {
    // The allowlist must reject before any key is used, so the bytes are moot.
    ciphertext = randomBytes(64);
  }
  const wrapped = options.recipient.publicKey!.encrypt(bytesToBinary(cek), 'RSAES-PKCS1-V1_5');
  const recipientInfo = seq([
    integerFromNumber(0),
    seq([rawDer(options.recipient.issuerDer), rawDer(options.recipient.serialDer)]),
    algorithmIdentifier('1.2.840.113549.1.1.1'),
    octetString(binaryToBytes(wrapped)),
  ]);
  const envelopedData = seq([
    integerFromNumber(0),
    setOf([recipientInfo]),
    seq([
      oid(OID_DATA),
      seq([oid(options.contentOid), octetString(iv)]),
      forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, false, bytesToBinary(ciphertext)),
    ]),
  ]);
  return encodeDer(seq([oid(OID_ENVELOPED_DATA), ctx(0, [envelopedData])]));
}

export function runSmimeSelfTest(): SelfTestReport {
  const started = Date.now();
  const r = new Recorder();

  // ── 1. CSPRNG ────────────────────────────────────────────────────────
  r.section('Random source');
  r.check('a platform CSPRNG is available', hasSecureRandom(), `source=${randomSourceName()}`);
  r.equal('randomBytes returns the requested length', randomBytes(48).length, 48);
  const a = bytesToHex(randomBytes(32));
  const b = bytesToHex(randomBytes(32));
  r.check('two draws differ', a !== b);
  r.check('draws are not all-zero', !/^0+$/.test(a));
  r.check('forge.random is routed through the platform CSPRNG',
    forge.random.getBytesSync(16).length === 16 && forge.random.getBytesSync(8) !== forge.random.getBytesSync(8));

  if (!hasSecureRandom()) {
    return {
      randomSource: randomSourceName(),
      passed: r.assertions.filter((x) => x.passed).length,
      failed: r.assertions.filter((x) => !x.passed).length,
      durationMs: Date.now() - started,
      assertions: r.assertions,
      fatal: 'No CSPRNG available — S/MIME is disabled on this device.',
    };
  }

  // ── 2. header sanitisation (audited finding: CRLF injection) ─────────
  r.section('Header sanitisation');
  r.equal('BCC injection via display name',
    stripCrlf('Evil\r\nBcc: attacker@evil.com'), 'Evil Bcc: attacker@evil.com');
  r.equal('bare LF', stripCrlf('a\nb'), 'a b');
  r.equal('bare CR', stripCrlf('a\rb'), 'a b');
  r.equal('folded continuation collapsed', stripCrlf('a\r\n\tb'), 'a b');
  r.equal('multiple injected headers',
    stripCrlf('x\r\nBcc: a@b.c\r\nReply-To: d@e.f'), 'x Bcc: a@b.c Reply-To: d@e.f');
  r.equal('clean value untouched', stripCrlf('Normal Subject'), 'Normal Subject');
  r.equal('non-ASCII survives sanitisation', stripCrlf('Grüße büro'), 'Grüße büro');
  r.check('formatHeader emits no bare CR/LF in the value',
    !/\r|\n/.test(formatHeader('Subject', 'a\r\nBcc: x@y.z').replace(/\r\n /g, ' ')));
  r.check('non-ASCII subject becomes an encoded-word',
    encodeHeaderValue('Grüße').startsWith('=?UTF-8?B?'));
  r.check('encoded-words never contain a bare newline',
    !/[\r\n]/.test(encodeHeaderValue('Grüße'.repeat(40)).replace(/\r\n /g, '')));
  r.check('display-name injection cannot escape the address',
    !formatAddress({ name: 'Evil\r\nBcc: a@b.c', email: ALICE }).includes('\n'));

  let identity: TestIdentity;
  try {
    // ── 3. identity generation + PKCS#12 round trip ────────────────────
    r.section('PKCS#12 import');
    const caKeys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
    const caDer = issueCertificate({ subjectCn: 'S/MIME Self-test CA', keys: caKeys, serial: '01', years: 5 });
    const caInfo = parseCertificate(caDer);
    const leafKeys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    const leafDer = issueCertificate({
      subjectCn: 'S/MIME Self-test Alice',
      email: ALICE,
      keys: leafKeys,
      issuer: { cn: 'S/MIME Self-test CA', key: caKeys.privateKey },
      serial: '4a1b2c3d',
    });

    const passphrase = 'self-test-passphrase';
    const p12 = toPkcs12(leafKeys.privateKey, [leafDer, caDer], passphrase);
    r.check('PKCS#12 produced', p12.length > 500, `${p12.length} bytes`);
    r.equal('PKCS#12 starts with a DER SEQUENCE', p12[0], 0x30);

    const imported = importPkcs12(p12, passphrase);
    identity = {
      privateKey: privateKeyFromPem(imported.privateKeyPem),
      certificate: imported.certificate,
      chain: imported.chain,
      p12,
    };
    r.check('import recovered a private key', !!imported.privateKeyPem);
    r.check('private key round-trips through PEM', !!identity.privateKey.n);
    r.equal('leaf paired with the key by modulus',
      imported.certificate.publicKey?.n?.toString(16), leafKeys.publicKey.n.toString(16));
    r.equal('chain carries the CA', imported.chain.length, 1);
    r.equal('leaf asserts the expected address', imported.certificate.emailAddresses[0], ALICE);
    r.equal('leaf serial parsed', imported.certificate.serialHex, '4a1b2c3d');
    r.check('leaf is not self-signed', imported.certificate.selfSigned === false);
    r.check('CA is self-signed', caInfo.selfSigned === true);
    r.check('leaf notAfter is in the future', new Date(imported.certificate.notAfter) > new Date());
    r.check('leaf notBefore is in the past', new Date(imported.certificate.notBefore) < new Date());
    r.equal('fingerprint is a sha-256 hex digest', imported.certificate.fingerprint.length, 64);
    r.check('issuer DER differs from subject DER',
      bytesToHex(imported.certificate.issuerDer) !== bytesToHex(imported.certificate.subjectDer));
    r.check('keyUsage allows signing and key encipherment',
      imported.certificate.keyUsage.digitalSignature && imported.certificate.keyUsage.keyEncipherment);
    r.throws('wrong passphrase is refused', () => importPkcs12(p12, 'wrong-passphrase'),
      (err) => err instanceof Pkcs12ImportError);
    r.throws('a non-PKCS#12 file is refused', () => importPkcs12(utf8ToBytes('not a p12'), passphrase),
      (err) => err instanceof Pkcs12ImportError);
    r.check('certAssertsAddress matches exactly',
      certAssertsAddress(imported.certificate.emailAddresses, ALICE));
    r.check('certAssertsAddress rejects a different address',
      !certAssertsAddress(imported.certificate.emailAddresses, BOB));
    r.check('certAssertsAddress rejects a substring',
      !certAssertsAddress(imported.certificate.emailAddresses, 'smime-test@sandbox.vnc.de.evil.com'));
  } catch (err) {
    return {
      randomSource: randomSourceName(),
      passed: r.assertions.filter((x) => x.passed).length,
      failed: r.assertions.filter((x) => !x.passed).length + 1,
      durationMs: Date.now() - started,
      assertions: r.assertions,
      fatal: `Identity setup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { privateKey, certificate, chain } = identity;
  const unlocked: UnlockedKey[] = [{ id: 'selftest', certificate, privateKey }];

  // ── 4. detached signature (multipart/signed) ────────────────────────
  r.section('Sign / verify (detached)');
  const signedContent = utf8ToBytes(
    'Content-Type: text/plain; charset=utf-8\r\n\r\nThe quick brown fox.\r\n',
  );
  const detachedCms = buildSignedData({
    content: signedContent, privateKey, signerCertificate: certificate, chain, detached: true,
  });
  r.check('detached CMS produced', detachedCms.length > 400, `${detachedCms.length} bytes`);
  const detachedOk = verifySignedData(detachedCms, {
    detachedContent: signedContent, fromAddress: ALICE,
  });
  r.check('detached signature verifies', detachedOk.status.signatureValid === true,
    detachedOk.status.signatureError);
  r.equal('digest algorithm is SHA-256', detachedOk.status.digestAlgorithm, 'sha256');
  r.check('digest is not flagged weak', detachedOk.status.weakDigest === false);
  r.check('signing time was recorded', !!detachedOk.status.signingTime);
  r.check('signer certificate was located', !!detachedOk.status.signerCertificate);
  r.equal('signer matches the From address', detachedOk.status.signerEmailMatch, true);
  r.equal('signer is not self-signed', detachedOk.status.selfSigned, false);
  r.check('certificate is not expired', detachedOk.status.certificateExpired === false);

  const tamperedContent = new Uint8Array(signedContent);
  tamperedContent[tamperedContent.length - 5] ^= 0x01;
  const tamperedVerify = verifySignedData(detachedCms, {
    detachedContent: tamperedContent, fromAddress: ALICE,
  });
  r.check('modified content fails verification', tamperedVerify.status.signatureValid === false);
  r.check('modified content reports a digest mismatch',
    /digest/i.test(tamperedVerify.status.signatureError ?? ''), tamperedVerify.status.signatureError);

  const tamperedCms = new Uint8Array(detachedCms);
  tamperedCms[tamperedCms.length - 3] ^= 0xff;
  const badSigVerify = verifySignedData(tamperedCms, {
    detachedContent: signedContent, fromAddress: ALICE,
  });
  r.check('modified signature fails verification', badSigVerify.status.signatureValid === false);

  const wrongFrom = verifySignedData(detachedCms, {
    detachedContent: signedContent, fromAddress: BOB,
  });
  r.equal('a different From address is reported as a mismatch', wrongFrom.status.signerEmailMatch, false);
  r.check('a From mismatch does not by itself invalidate the signature',
    wrongFrom.status.signatureValid === true);
  const noFrom = verifySignedData(detachedCms, { detachedContent: signedContent });
  r.equal('no From address leaves the match undecided', noFrom.status.signerEmailMatch, undefined);

  // ── 5. opaque signature ─────────────────────────────────────────────
  r.section('Sign / verify (opaque)');
  const opaqueCms = buildSignedData({
    content: signedContent, privateKey, signerCertificate: certificate, chain, detached: false,
  });
  const opaqueOk = verifySignedData(opaqueCms, { fromAddress: ALICE });
  r.check('opaque signature verifies', opaqueOk.status.signatureValid === true,
    opaqueOk.status.signatureError);
  r.equal('embedded content is recovered byte-for-byte',
    opaqueOk.content ? bytesToHex(opaqueOk.content) : '', bytesToHex(signedContent));

  // ── 6. encrypt / decrypt (AES-256-GCM) ──────────────────────────────
  r.section('Encrypt / decrypt (AES-256-GCM)');
  const plaintext = utf8ToBytes(
    'Content-Type: text/plain; charset=utf-8\r\n\r\nSecret: 42. Grüße.\r\n',
  );
  const envelope = buildEnvelopedData({ content: plaintext, recipients: [certificate] });
  r.check('EnvelopedData produced', envelope.length > 400, `${envelope.length} bytes`);
  r.check('ciphertext does not contain the plaintext',
    !bytesToHex(envelope).includes(bytesToHex(utf8ToBytes('Secret: 42'))));
  const decrypted = decryptEnvelopedData({ cmsDer: envelope, unlocked, locked: [] });
  r.equal('plaintext recovered', bytesToUtf8(decrypted.content), bytesToUtf8(plaintext));
  r.equal('content algorithm reported', decrypted.contentAlgorithm, 'AES-256-GCM');
  r.check('GCM is reported as authenticated', decrypted.contentAuthenticated === true);
  r.check('modern key transport is used (not PKCS#1 v1.5)', decrypted.legacyKeyTransport === false);
  r.equal('the decrypting key is identified', decrypted.keyId, 'selftest');

  const tamperedEnvelope = new Uint8Array(envelope);
  // Flip a byte inside the encrypted content, near the end but before the tag.
  tamperedEnvelope[tamperedEnvelope.length - 40] ^= 0x01;
  r.throws('a modified GCM ciphertext is refused',
    () => decryptEnvelopedData({ cmsDer: tamperedEnvelope, unlocked, locked: [] }),
    (err) => err instanceof SmimeDecryptError);

  const strangerKeys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const strangerCert = parseCertificate(issueCertificate({
    subjectCn: 'Stranger', email: BOB, keys: strangerKeys, serial: '09',
  }));
  r.throws('a message addressed to someone else finds no key',
    () => decryptEnvelopedData({
      cmsDer: buildEnvelopedData({ content: plaintext, recipients: [strangerCert] }),
      unlocked,
      locked: [],
    }),
    (err) => err instanceof SmimeNoKeyError);

  const twoRecipients = buildEnvelopedData({
    content: plaintext, recipients: [strangerCert, certificate],
  });
  r.equal('multi-recipient envelope still decrypts for us',
    bytesToUtf8(decryptEnvelopedData({ cmsDer: twoRecipients, unlocked, locked: [] }).content),
    bytesToUtf8(plaintext));

  const aes128 = buildEnvelopedData({ content: plaintext, recipients: [certificate], keyLength: 128 });
  r.equal('AES-128-GCM is selectable',
    decryptEnvelopedData({ cmsDer: aes128, unlocked, locked: [] }).contentAlgorithm, 'AES-128-GCM');

  // ── 7. algorithm allowlist (audited finding: EFAIL / weak ciphers) ──
  r.section('Content-encryption allowlist');
  r.equal('AES-256-GCM is authenticated',
    resolveContentEncryption('2.16.840.1.101.3.4.1.46').authenticated, true);
  r.equal('AES-128-CBC is accepted for interop',
    resolveContentEncryption('2.16.840.1.101.3.4.1.2').name, 'AES-128-CBC');
  r.equal('AES-128-CBC is NOT authenticated',
    resolveContentEncryption('2.16.840.1.101.3.4.1.2').authenticated, false);
  for (const [label, badOid] of [
    ['3DES-CBC', '1.2.840.113549.3.7'],
    ['DES-CBC', '1.3.14.3.2.7'],
    ['RC2-CBC', '1.2.840.113549.3.2'],
    ['an unknown OID', '1.2.3.4.5'],
  ] as const) {
    r.throws(`${label} is refused`, () => resolveContentEncryption(badOid),
      (err) => err instanceof SmimeAlgorithmRefusedError);
  }
  r.throws('a 3DES-encrypted message is refused before any key is used',
    () => decryptEnvelopedData({
      cmsDer: buildLegacyEnvelope({
        content: plaintext, recipient: certificate,
        contentOid: '1.2.840.113549.3.7', cipher: 'none', keyLength: 24,
      }),
      unlocked,
      locked: [],
    }),
    (err) => err instanceof SmimeAlgorithmRefusedError);

  // A real AES-256-CBC message (what Outlook / Thunderbird send) must still be
  // readable, but must be flagged as unauthenticated.
  const cbcEnvelope = buildLegacyEnvelope({
    content: plaintext, recipient: certificate,
    contentOid: '2.16.840.1.101.3.4.1.42', cipher: 'AES-CBC', keyLength: 32,
  });
  const cbcDecrypted = decryptEnvelopedData({ cmsDer: cbcEnvelope, unlocked, locked: [] });
  r.equal('AES-256-CBC mail is still readable', bytesToUtf8(cbcDecrypted.content), bytesToUtf8(plaintext));
  r.check('AES-256-CBC is flagged unauthenticated', cbcDecrypted.contentAuthenticated === false);
  r.check('legacy RSAES-PKCS1-v1_5 key transport is accepted on read',
    cbcDecrypted.legacyKeyTransport === true);

  // ── 8. whole-message round trip ─────────────────────────────────────
  r.section('Message round trip');
  const html = '<p>Hello <b>encrypted</b> world &amp; Grüße</p>';
  const text = 'Hello encrypted world & Grüße';
  const built = buildOutgoingSmime({
    from: [{ name: 'Alice\r\nBcc: attacker@evil.com', email: ALICE }],
    to: [{ name: 'Alice', email: ALICE }],
    subject: 'Grüße from the self-test',
    text,
    html,
    messageId: generateMessageId('sandbox.vnc.de'),
    sign: { privateKey, certificate, chain },
    encryptTo: [certificate],
  });
  r.check('signed+encrypted message built', built.signed && built.encrypted);
  const rawText = bytesToUtf8(built.bytes);
  r.check('outer message carries no injected Bcc header', !/^Bcc:/m.test(rawText));
  r.check('outer message is enveloped-data',
    /Content-Type: application\/pkcs7-mime; smime-type=enveloped-data/.test(rawText));
  r.check('plaintext body is absent from the wire format', !rawText.includes('encrypted</b>'));

  const processed = processSmimeMessage({
    raw: built.bytes, fromAddress: ALICE, unlockedKeys: unlocked, lockedKeys: [],
  });
  r.check('processing reports no error', !processed.error, processed.error);
  r.check('processed message is encrypted', processed.isEncrypted === true);
  r.check('processed message is signed', processed.isSigned === true);
  r.check('inner signature verifies after decryption', processed.signature?.signatureValid === true,
    processed.signature?.signatureError);
  r.equal('HTML body recovered', processed.html, html);
  r.equal('text body recovered', processed.text, text);
  r.check('content is authenticated', processed.contentAuthenticated === true);
  r.check('HTML rendering is allowed for authenticated content', processed.suppressHtml === false);

  const signOnly = buildOutgoingSmime({
    from: [{ email: ALICE }], to: [{ email: BOB }], subject: 'Signed only',
    text, messageId: generateMessageId('sandbox.vnc.de'),
    sign: { privateKey, certificate, chain },
  });
  r.check('sign-only message is multipart/signed',
    /Content-Type: multipart\/signed/.test(bytesToUtf8(signOnly.bytes)));
  const signOnlyProcessed = processSmimeMessage({
    raw: signOnly.bytes, fromAddress: ALICE, unlockedKeys: [], lockedKeys: [],
  });
  r.check('sign-only message verifies end to end',
    signOnlyProcessed.signature?.signatureValid === true, signOnlyProcessed.signature?.signatureError);
  r.equal('sign-only body recovered', signOnlyProcessed.text, text);
  r.check('sign-only message is readable without any key', signOnlyProcessed.isEncrypted === false);

  // EFAIL: an unauthenticated (CBC) message must have its HTML suppressed.
  const cbcMessage = concatBytes([
    utf8ToBytes(
      'MIME-Version: 1.0\r\nFrom: <' + ALICE + '>\r\nSubject: legacy\r\n'
      + 'Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n'
      + 'Content-Transfer-Encoding: base64\r\n\r\n',
    ),
    utf8ToBytes(bytesToBase64(buildLegacyEnvelope({
      content: utf8ToBytes(
        'Content-Type: text/html; charset=utf-8\r\n\r\n<p>legacy body</p>\r\n',
      ),
      recipient: certificate,
      contentOid: '2.16.840.1.101.3.4.1.42',
      cipher: 'AES-CBC',
      keyLength: 32,
    }))),
  ]);
  const cbcProcessed = processSmimeMessage({
    raw: cbcMessage, fromAddress: ALICE, unlockedKeys: unlocked, lockedKeys: [],
  });
  r.check('unauthenticated message still decrypts', !cbcProcessed.error, cbcProcessed.error);
  r.check('unauthenticated content is flagged', cbcProcessed.contentAuthenticated === false);
  r.check('EFAIL guard suppresses HTML for unauthenticated content',
    cbcProcessed.suppressHtml === true);
  r.check('the suppressed body is still available as text', !!cbcProcessed.html);

  // ── 9. auto-import gate (audited finding: cert substitution) ────────
  r.section('Certificate auto-import gate');
  const goodStatus = {
    signatureValid: true as const,
    signerCertificate: certificate,
    signerEmailMatch: true as const,
    selfSigned: false as const,
  };
  const existing: StoredCertRecord[] = [];
  r.equal('CA-signed, address matches → import',
    decideAutoImport({ status: goodStatus, fromAddress: ALICE, enabled: true, existing }).action, 'import');
  r.equal('THE ATTACK: self-signed with a matching address → refuse',
    decideAutoImport({
      status: { ...goodStatus, selfSigned: true }, fromAddress: ALICE, enabled: true, existing,
    }).action, 'skip');
  r.equal('address mismatch → refuse',
    decideAutoImport({
      status: { ...goodStatus, signerEmailMatch: false }, fromAddress: ALICE, enabled: true, existing,
    }).action, 'skip');
  r.equal('undecidable match (no From) → refuse, fail closed',
    decideAutoImport({
      status: { ...goodStatus, signerEmailMatch: undefined }, fromAddress: undefined,
      enabled: true, existing,
    }).action, 'skip');
  r.equal('invalid signature → refuse',
    decideAutoImport({
      status: { ...goodStatus, signatureValid: false }, fromAddress: ALICE, enabled: true, existing,
    }).action, 'skip');
  r.equal('setting off → refuse',
    decideAutoImport({ status: goodStatus, fromAddress: ALICE, enabled: false, existing }).action, 'skip');
  const conflicting: StoredCertRecord[] = [{
    id: 'x', email: ALICE, subject: 'other', issuer: 'other',
    notBefore: '', notAfter: '', fingerprint: 'deadbeef',
    certificate: '', source: 'manual', addedAt: '',
  }];
  const conflict = decideAutoImport({
    status: goodStatus, fromAddress: ALICE, enabled: true, existing: conflicting,
  });
  r.equal('a stored certificate is never silently replaced', conflict.action, 'skip');
  r.equal('...and the refusal names the conflict',
    conflict.action === 'skip' ? conflict.reason : '', 'conflicts-with-stored');
  r.equal('an identical certificate is a no-op',
    (() => {
      const same = decideAutoImport({
        status: goodStatus, fromAddress: ALICE, enabled: true,
        existing: [{ ...conflicting[0], fingerprint: certificate.fingerprint }],
      });
      return same.action === 'skip' ? same.reason : '';
    })(), 'already-known');

  // ── 10. MIME builder + parser ───────────────────────────────────────
  r.section('MIME builder / parser');
  const inner = buildInnerMime({
    text: 'plain', html: '<p>rich</p>',
    attachments: [{
      filename: 'evil"\r\nBcc: a@b.c.txt',
      contentType: 'text/plain\r\nBcc: a@b.c',
      bytes: utf8ToBytes('file body'),
    }],
    boundaries: {
      alternative: makeBoundary('alt', bytesToHex(randomBytes(8))),
      mixed: makeBoundary('mix', bytesToHex(randomBytes(8))),
    },
  });
  const innerText = bytesToUtf8(inner);
  r.check('attachment content-type injection is stripped', !/^Bcc:/m.test(innerText));
  r.check('attachment filename injection is stripped',
    !innerText.split('\r\n').some((line) => line.startsWith('Bcc:')));
  const parsedInner = flattenMime(parseMime(inner));
  r.equal('multipart text part parsed', parsedInner.text, 'plain');
  r.equal('multipart html part parsed', parsedInner.html, '<p>rich</p>');
  r.equal('attachment parsed', parsedInner.attachments.length, 1);
  r.equal('attachment bytes round-trip',
    parsedInner.attachments[0] ? bytesToUtf8(parsedInner.attachments[0].bytes) : '', 'file body');
  r.equal('quoted boundary containing a semicolon survives',
    parseContentTypeHeader('multipart/mixed; boundary="a;b"').params.boundary, 'a;b');
  r.equal('content-type is lowercased', parseContentTypeHeader('TEXT/HTML; CHARSET=UTF-8').type, 'text/html');
  // Bounded parsing: a deeply nested multipart must terminate, not recurse away.
  let nested = 'Content-Type: text/plain\r\n\r\nbottom\r\n';
  for (let i = 0; i < 40; i++) {
    nested = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${nested}\r\n--b${i}--\r\n`;
  }
  const deep = parseMime(utf8ToBytes(nested));
  r.check('deeply nested MIME parses without exhausting the stack', !!deep);
  r.check('base64 helper round-trips', bytesToUtf8(base64ToBytes(bytesToBase64(utf8ToBytes('ok')))) === 'ok');

  const passed = r.assertions.filter((x) => x.passed).length;
  const failed = r.assertions.length - passed;
  return {
    randomSource: randomSourceName(),
    passed,
    failed,
    durationMs: Date.now() - started,
    assertions: r.assertions,
  };
}
