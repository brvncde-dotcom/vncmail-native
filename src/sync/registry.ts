// The registry (§8.1, §8.3, §8.4.1). Deliberately tiny and deliberately OUTSIDE
// every per-account namespace:
//
//   <per-account store>   -> mailbox, envelope, email_mailbox, body, body_queue,
//                            sync_state (cursors, coverage, flags) — ALL of it
//                            inside the account's own database file
//   vncmail:sync:registry -> ONLY: account ids present, purge tombstones,
//                            monotonic epochs, and the out-of-band store-format
//                            marker (§8.4.1)
//
// No cursor, coverage row, record or resync flag may live here. That is the
// forward-compatibility requirement that makes the SQLCipher flip work: deleting
// the key and the file removes all of an account's sync state together. A cursor
// in a shared blob would survive the wipe and then be advanced against a
// freshly-empty store, skipping changes that would never be re-delivered.
//
// Two things must live outside the purged namespace:
//   * `epoch`, because it must be monotonic ACROSS a purge (§8.3). If it reset
//     when an account were purged and re-added, an in-flight cycle holding epoch
//     0 could commit into the fresh namespace.
//   * the format marker, because `schemaVersion` otherwise lives inside the file
//     that the encryption flip makes unreadable — you cannot read the version out
//     of a database you can no longer open (§8.4.1, V4).
//
// Accepted limitation (S16): this stores plaintext `username@host` per account,
// outside any encrypted store. Unavoidable — the engine must know which accounts
// exist and which purges are pending BEFORE any key is available. It adds no new
// exposure: `src/stores/account-store.ts` already persists `username` and `email`
// for every account to plain AsyncStorage (`account-store.ts:150-151`). If that
// ever moves to expo-secure-store, this should move with it.

import AsyncStorage from '@react-native-async-storage/async-storage';

import { mutexFor } from './mutex';
import type { LocalAccountId } from './states';
import type { StoreFormatMarker } from './store';

/** `vncmail:` rather than upstream's `webmail:`, so the v2 caches cannot alias (§8.1). */
export const REGISTRY_KEY = 'vncmail:sync:registry';

export interface RegistryEntry {
  accountId: LocalAccountId;
  /** Monotonic across purges. Never decreases, never resets. */
  epoch: number;
  /** Durable purge intent, written FIRST so a crash mid-purge is recoverable (§8.4). */
  purgePending?: boolean;
  /** Present iff a store has been materialised. Written LAST (§8.4.1). */
  storeFormat?: StoreFormatMarker['storeFormat'];
  /** Mirror of the in-file value, so a mismatch is detectable without opening the file. */
  schemaVersion?: number;
}

type RegistryFile = Record<LocalAccountId, RegistryEntry>;

async function read(): Promise<RegistryFile> {
  const raw = await AsyncStorage.getItem(REGISTRY_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as RegistryFile;
  } catch {
    // A corrupt registry must NOT throw: it is read before anything else can
    // run, so throwing here is an unrecoverable launch loop. Treating it as
    // empty makes every account look unmaterialised with a missing marker,
    // which §8.4.1 already handles as a mismatch -> purge -> re-bootstrap. The
    // only cost is one lost epoch sequence, and the purge is what makes that
    // safe.
    return {};
  }
}

async function write(file: RegistryFile): Promise<void> {
  // Never `void setItem(...).catch(warn)`: I4 bans silent write loss, and D2 is
  // the catalogue of what that pattern already cost this codebase.
  await AsyncStorage.setItem(REGISTRY_KEY, JSON.stringify(file));
}

/** All registry mutations serialise, so a read-modify-write cannot lose an epoch bump. */
function withRegistry<T>(fn: (file: RegistryFile) => Promise<T> | T): Promise<T> {
  return mutexFor(REGISTRY_KEY).run(async () => {
    const file = await read();
    const out = await fn(file);
    await write(file);
    return out;
  });
}

export class SyncRegistry {
  async entry(accountId: LocalAccountId): Promise<RegistryEntry | null> {
    const file = await read();
    return file[accountId] ?? null;
  }

  /**
   * Accounts with a materialised store and no pending purge — i.e. the accounts
   * that actually hold sync state right now.
   */
  async listAccounts(): Promise<LocalAccountId[]> {
    const file = await read();
    return Object.values(file)
      .filter((e) => e.storeFormat !== undefined && !e.purgePending)
      .map((e) => e.accountId)
      .sort();
  }

  /** Every entry, including purge-pending ones. For `completePendingPurges()`. */
  async listEntries(): Promise<RegistryEntry[]> {
    const file = await read();
    return Object.values(file).sort((a, b) => a.accountId.localeCompare(b.accountId));
  }

  async epochFor(accountId: LocalAccountId): Promise<number> {
    const file = await read();
    return file[accountId]?.epoch ?? 0;
  }

  /**
   * Not writable from a `SyncTxn` (§8.3): a transaction READS the epoch to
   * validate itself and can never bump one. Bumped on login, logout, account
   * switch to this account, purge, `clearRecords()`, and the offline-cache
   * feature being disabled.
   */
  async bumpEpoch(accountId: LocalAccountId, _reason: string): Promise<number> {
    return withRegistry((file) => {
      const current = file[accountId] ?? { accountId, epoch: 0 };
      const next = { ...current, epoch: current.epoch + 1 };
      file[accountId] = next;
      return next.epoch;
    });
  }

  async readFormatMarker(accountId: LocalAccountId): Promise<StoreFormatMarker | null> {
    const e = await this.entry(accountId);
    if (!e || e.storeFormat === undefined || e.schemaVersion === undefined) return null;
    return { storeFormat: e.storeFormat, schemaVersion: e.schemaVersion };
  }

  async writeFormatMarker(
    accountId: LocalAccountId,
    marker: StoreFormatMarker,
  ): Promise<void> {
    await withRegistry((file) => {
      const current = file[accountId] ?? { accountId, epoch: 0 };
      file[accountId] = {
        ...current,
        storeFormat: marker.storeFormat,
        schemaVersion: marker.schemaVersion,
      };
    });
  }

  /** §8.4 step 1: durable intent, written before anything is destroyed. */
  async markPurgePending(accountId: LocalAccountId): Promise<void> {
    await withRegistry((file) => {
      const current = file[accountId] ?? { accountId, epoch: 0 };
      file[accountId] = { ...current, purgePending: true };
    });
  }

  /**
   * §8.4 step 5: remove the entry — but KEEP the epoch, which is the whole
   * reason it lives out here. Re-adding the account starts from the same
   * sequence, so an in-flight cycle from before the purge still fails its
   * epoch check.
   */
  async completePurge(accountId: LocalAccountId): Promise<void> {
    await withRegistry((file) => {
      const current = file[accountId];
      file[accountId] = { accountId, epoch: current?.epoch ?? 0 };
    });
  }
}

export const syncRegistry = new SyncRegistry();
