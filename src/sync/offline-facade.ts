// THE single branch point between the v1 offline cache and the v2 delta-sync engine.
//
// Why this module exists rather than a flag check in each screen: it already went wrong
// exactly that way. `OfflineCacheBanner` branched on `offlineSyncEngineV2` correctly and
// its sibling `AboutDataSettings` did not, so on a real device with 761 envelopes in
// SQLite the Settings screen reported "Nothing cached yet", "Sync now" ran the v1 bulk
// downloader (kicking off a second, competing offline copy), and "Clear offline mail"
// would have cleared the store that wasn't holding the mail.
//
// Duplicated branching logic is the defect class, so the fix is to have ONE branch and a
// test that enforces there is only one. Every UI consumer calls these functions; nothing
// outside this module reads `useOfflineCacheStore` or calls `runOfflineSync`.

import { jmapClient } from '../api/jmap-client';
import { runOfflineSync } from '../lib/offline-sync';
import { useAuthStore } from '../stores/auth-store';
import { useOfflineCacheStore } from '../stores/offline-cache-store';
import { useSettingsStore } from '../stores/settings-store';
import { currentSyncWiring } from './app-wiring';
import { sqliteStoreFactory } from './store-sqlite';
import type { SyncStoreFactory } from './store';
import type { TriggerReason } from './triggers';

export interface OfflineStats {
  count: number;
  bytes: number;
  /** Which store the numbers came from — useful for labels, and for tests. */
  source: 'v1' | 'v2';
}

/** Where an action actually landed. `unavailable` means nothing was done. */
export type OfflineTarget = 'v1' | 'v2' | 'unavailable';

export interface OfflineFacadeDeps {
  factory: SyncStoreFactory;
  engineEnabled(): boolean;
  cacheEnabled(): boolean;
  localAccountId(): string | null;
  jmapAccountId(): string | null;
  /** Returns false when the engine is flagged on but not actually wired yet. */
  fireTrigger(reason: TriggerReason): boolean;
  runV1Sync(): Promise<void>;
  v1Stats(): { count: number; bytes: number };
  clearV1(): Promise<void>;
}

function liveDeps(): OfflineFacadeDeps {
  return {
    factory: sqliteStoreFactory,
    // Split into the two halves the tests want to vary independently; the live conjunction
    // is exactly `offlineEngineOwnsStore()`.
    engineEnabled: () => useSettingsStore.getState().offlineSyncEngineV2,
    cacheEnabled: () => useSettingsStore.getState().offlineCacheEnabled,
    localAccountId: () => useAuthStore.getState().activeAccountId,
    jmapAccountId: () => jmapClient.accountId ?? null,
    fireTrigger: (reason) => {
      const wiring = currentSyncWiring();
      if (!wiring) return false;
      wiring.coordinator.fire(reason);
      return true;
    },
    runV1Sync: async () => {
      const s = useSettingsStore.getState();
      await runOfflineSync({ days: s.offlineCacheDays, maxMB: s.offlineCacheMaxMB });
    },
    v1Stats: () => {
      const cache = useOfflineCacheStore.getState();
      return { count: cache.totalCount(), bytes: cache.totalSize() };
    },
    clearV1: () => useOfflineCacheStore.getState().clearAll(),
  };
}

function resolve(overrides?: Partial<OfflineFacadeDeps>): OfflineFacadeDeps {
  return overrides ? { ...liveDeps(), ...overrides } : liveDeps();
}

/**
 * The one place the flag is interpreted.
 *
 * Both conditions matter: the engine only runs when offline caching is on at all (§9.5
 * keeps a disabled account's store unmaterialised), so "flag on, feature off" must read as
 * v1 — otherwise the UI would report on a store that will never exist.
 */
export function offlineEngineActive(overrides?: Partial<OfflineFacadeDeps>): boolean {
  const d = resolve(overrides);
  // Injectable for tests, but the LIVE answer comes from `offlineEngineOwnsStore()` — see
  // `liveDeps()`. Same predicate, one definition.
  return d.engineEnabled() && d.cacheEnabled();
}

/** T3 — user-initiated, never throttled (§10.1). */
export async function syncNow(overrides?: Partial<OfflineFacadeDeps>): Promise<OfflineTarget> {
  const d = resolve(overrides);
  if (!d.cacheEnabled()) return 'unavailable';

  if (d.engineEnabled()) {
    // Deliberately NO v1 fallback here. Running the v1 downloader because the engine is
    // not wired yet is what produced the original bug's second symptom: a competing bulk
    // download writing an offline copy of the same mail from a different cursor, which
    // §14.2 exists to prevent. Better to report that nothing happened.
    return d.fireTrigger('manual') ? 'v2' : 'unavailable';
  }

  await d.runV1Sync();
  return 'v1';
}

export async function offlineStats(
  overrides?: Partial<OfflineFacadeDeps>,
): Promise<OfflineStats> {
  const d = resolve(overrides);
  if (!offlineEngineActive(overrides)) {
    return { ...d.v1Stats(), source: 'v1' };
  }

  const accountId = d.localAccountId();
  const jmapAccountId = d.jmapAccountId();
  if (!accountId || !jmapAccountId) return { count: 0, bytes: 0, source: 'v2' };
  // §9.5: reading must not materialise anything for an account that has never synced.
  if (!(await d.factory.isMaterialised(accountId))) {
    return { count: 0, bytes: 0, source: 'v2' };
  }

  const store = await d.factory.open(accountId);
  // Envelopes are the honest "messages available offline" count — that is what the offline
  // list renders. Bytes are body-tier only, which is also what the MB cap governs (§2.1),
  // so the two numbers answer "how many messages" and "how much disk" rather than mixing
  // the tiers.
  const [count, bytes] = await Promise.all([
    store.countEnvelopes({ jmapAccountId }),
    store.bodyBytesTotal(),
  ]);
  return { count, bytes, source: 'v2' };
}

/**
 * "Clear offline mail".
 *
 * On v2 this is `clearRecords()`, which per §9.1 wipes records AND the body queue, sets
 * `resyncRequired`, and bumps the epoch so an in-flight cycle cannot write over the wipe
 * (F35/F37) — while deliberately NOT nulling the cursors (§7.5 rule 7). Nulling them would
 * leave the engine unable to tell what it still needs; the sticky resync flag is what makes
 * the rebuild happen.
 */
export async function clearOfflineMail(
  overrides?: Partial<OfflineFacadeDeps>,
): Promise<OfflineTarget> {
  const d = resolve(overrides);
  if (!offlineEngineActive(overrides)) {
    await d.clearV1();
    return 'v1';
  }

  const accountId = d.localAccountId();
  if (!accountId) return 'unavailable';
  if (!(await d.factory.isMaterialised(accountId))) return 'v2';
  const store = await d.factory.open(accountId);
  await store.clearRecords();
  return 'v2';
}
