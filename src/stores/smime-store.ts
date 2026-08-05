/**
 * S/MIME state: imported identities, recipient certificates, unlock state, and a
 * per-message cache of processed results.
 *
 * The crypto itself lives in `src/lib/smime/*` and is pure. This store is the
 * only place that touches the network (fetching a message's raw MIME blob) and
 * persistent storage, which keeps the cryptographic core testable in Node.
 */
import { create } from 'zustand';
import { jmapClient } from '../api/jmap-client';
import type { Email } from '../api/types';
import { detectSmime, type SmimeKind } from '../lib/smime/detect';
import { processSmimeMessage, type SmimeResult } from '../lib/smime/message';
import { importPkcs12, parseCertificateFile } from '../lib/smime/pkcs12';
import { decideAutoImport, describeRefusal } from '../lib/smime/autoimport';
import { hasSecureRandom, randomSourceName } from '../lib/smime/forge';
import type { CertificateInfo } from '../lib/smime/certificate';
import type { LockedKeyRef, UnlockedKey } from '../lib/smime/cms-decrypt';
import {
  applyRememberUnlocked, autoUnlockAll, deleteCertRecord, deleteKeyRecord, findCertificateFor,
  findSigningIdentity, getUnlockedKey, hasStoredPassphrase, importKeyRecord, listCertRecords,
  listKeyRecords, lockAll, lockKey, safeParse, saveCertRecord, unlockKey,
  type StoredCertRecord, type StoredKeyRecord,
} from '../lib/smime/keystore';
import { useSettingsStore } from './settings-store';

export interface KeyListEntry {
  record: StoredKeyRecord;
  certificate?: CertificateInfo;
  unlocked: boolean;
  /** Unlocks without prompting because the passphrase is in SecureStore. */
  remembered: boolean;
}

interface SmimeState {
  hydrated: boolean;
  available: boolean;
  randomSource: string;
  keys: KeyListEntry[];
  certs: StoredCertRecord[];
  /** Processed S/MIME results, keyed by email id. */
  results: Record<string, SmimeResult | undefined>;
  /** Emails currently being processed. */
  pending: Record<string, boolean>;
  lastNotice?: string;

  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;

  importIdentity: (bytes: Uint8Array, passphrase: string) => Promise<StoredKeyRecord>;
  importRecipientCertificate: (bytes: Uint8Array) => Promise<number>;
  removeKey: (id: string) => Promise<void>;
  removeCert: (id: string) => Promise<void>;
  unlock: (id: string, passphrase?: string) => Promise<boolean>;
  lock: (id: string) => Promise<void>;
  lockEverything: () => void;
  setRememberUnlocked: (remember: boolean) => Promise<void>;

  /** Detect + fetch + process, memoised per email id. */
  processEmail: (email: Email, accountId?: string) => Promise<SmimeResult | undefined>;
  resultFor: (emailId: string) => SmimeResult | undefined;
  clearNotice: () => void;
}

function unlockedKeyList(entries: KeyListEntry[]): UnlockedKey[] {
  const out: UnlockedKey[] = [];
  for (const entry of entries) {
    const privateKey = getUnlockedKey(entry.record.id);
    if (privateKey && entry.certificate) {
      out.push({ id: entry.record.id, certificate: entry.certificate, privateKey });
    }
  }
  return out;
}

function lockedKeyList(entries: KeyListEntry[]): LockedKeyRef[] {
  const out: LockedKeyRef[] = [];
  for (const entry of entries) {
    if (entry.certificate) out.push({ id: entry.record.id, certificate: entry.certificate });
  }
  return out;
}

async function loadEntries(): Promise<KeyListEntry[]> {
  const records = await listKeyRecords();
  return Promise.all(records.map(async (record) => ({
    record,
    certificate: safeParse(record.certificate),
    unlocked: !!getUnlockedKey(record.id),
    remembered: await hasStoredPassphrase(record.id),
  })));
}

export const useSmimeStore = create<SmimeState>((set, get) => ({
  hydrated: false,
  available: hasSecureRandom(),
  randomSource: randomSourceName(),
  keys: [],
  certs: [],
  results: {},
  pending: {},

  hydrate: async () => {
    if (get().hydrated) return;
    // Keys whose passphrase the user chose to remember come back unlocked.
    await autoUnlockAll().catch(() => []);
    set({
      keys: await loadEntries(),
      certs: await listCertRecords(),
      hydrated: true,
      available: hasSecureRandom(),
      randomSource: randomSourceName(),
    });
  },

  refresh: async () => {
    set({ keys: await loadEntries(), certs: await listCertRecords() });
  },

  importIdentity: async (bytes, passphrase) => {
    const identity = importPkcs12(bytes, passphrase);
    const remember = useSettingsStore.getState().smimeRememberUnlocked;
    const record = await importKeyRecord({ identity, passphrase, remember });
    await get().refresh();
    // A new identity can change how already-open messages render.
    set({ results: {} });
    return record;
  },

  importRecipientCertificate: async (bytes) => {
    const certs = parseCertificateFile(bytes);
    let saved = 0;
    for (const cert of certs) {
      const address = cert.emailAddresses[0];
      if (!address) continue;
      await saveCertRecord(cert, address, 'manual');
      saved += 1;
    }
    await get().refresh();
    if (saved === 0) {
      set({
        lastNotice: 'That certificate asserts no email address, so it cannot be used to encrypt mail.',
      });
    }
    return saved;
  },

  removeKey: async (id) => {
    await deleteKeyRecord(id);
    set({ results: {} });
    await get().refresh();
  },

  removeCert: async (id) => {
    await deleteCertRecord(id);
    await get().refresh();
  },

  unlock: async (id, passphrase) => {
    const ok = await unlockKey(id, passphrase);
    if (ok && passphrase != null && useSettingsStore.getState().smimeRememberUnlocked) {
      const { rememberPassphrase } = await import('../lib/smime/keystore');
      await rememberPassphrase(id, passphrase).catch(() => {});
    }
    if (ok) set({ results: {} });
    await get().refresh();
    return ok;
  },

  lock: async (id) => {
    await lockKey(id);
    set({ results: {} });
    await get().refresh();
  },

  lockEverything: () => {
    lockAll();
    set({ results: {}, keys: get().keys.map((k) => ({ ...k, unlocked: false })) });
  },

  setRememberUnlocked: async (remember) => {
    useSettingsStore.getState().updateSetting('smimeRememberUnlocked', remember);
    // Turning the setting off must actively forget what was already stored,
    // otherwise the switch is decorative for existing keys.
    await applyRememberUnlocked(remember);
    await get().refresh();
  },

  processEmail: async (email, accountId) => {
    const existing = get().results[email.id];
    if (existing) return existing;
    if (get().pending[email.id]) return undefined;
    if (detectSmime(email) === 'none') return undefined;
    if (!email.blobId) {
      const result: SmimeResult = {
        isSigned: false, isEncrypted: false, contentAuthenticated: false,
        suppressHtml: false, attachments: [],
        error: 'The server did not provide the raw message, so it cannot be verified.',
      };
      set({ results: { ...get().results, [email.id]: result } });
      return result;
    }

    set({ pending: { ...get().pending, [email.id]: true } });
    try {
      const buffer = await jmapClient.fetchBlobArrayBuffer(
        email.blobId, 'message.eml', 'message/rfc822', accountId,
      );
      const entries = get().keys;
      const fromAddress = email.from?.[0]?.email;
      const result = processSmimeMessage({
        raw: new Uint8Array(buffer),
        fromAddress,
        unlockedKeys: unlockedKeyList(entries),
        lockedKeys: lockedKeyList(entries),
      });

      await maybeAutoImportSigner(result, fromAddress, get, set);

      set({ results: { ...get().results, [email.id]: result } });
      return result;
    } catch (err) {
      const result: SmimeResult = {
        isSigned: false, isEncrypted: false, contentAuthenticated: false,
        suppressHtml: false, attachments: [],
        error: err instanceof Error ? err.message : 'Could not process the S/MIME message',
      };
      set({ results: { ...get().results, [email.id]: result } });
      return result;
    } finally {
      const pending = { ...get().pending };
      delete pending[email.id];
      set({ pending });
    }
  },

  resultFor: (emailId) => get().results[emailId],
  clearNotice: () => set({ lastNotice: undefined }),
}));

/**
 * Save a signer certificate — only when every gate in `decideAutoImport` says so.
 * A refusal that the user would want to know about (a conflicting certificate
 * already on file) is surfaced; the routine ones stay quiet.
 */
async function maybeAutoImportSigner(
  result: SmimeResult,
  fromAddress: string | undefined,
  get: () => SmimeState,
  set: (partial: Partial<SmimeState>) => void,
): Promise<void> {
  if (!result.signature?.signerCertificate) return;
  const decision = decideAutoImport({
    status: result.signature,
    fromAddress,
    enabled: useSettingsStore.getState().smimeAutoImport,
    existing: get().certs,
  });
  if (decision.action !== 'import') {
    if (decision.reason === 'conflicts-with-stored') {
      set({ lastNotice: describeRefusal(decision.reason) });
    }
    return;
  }
  await saveCertRecord(result.signature.signerCertificate, decision.address, 'signed-email');
  set({ certs: await listCertRecords() });
}

export type { SmimeKind };
export { findCertificateFor, findSigningIdentity };
