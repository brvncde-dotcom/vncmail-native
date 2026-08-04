// Small helpers the Settings screen needs, kept out of the component so the §8.4 purge
// sequence lives next to the engine that defines it.

import { sqliteStoreFactory } from './store-sqlite';
import type { PurgeReason } from './store';
import { stopSyncEngine } from './app-wiring';

/**
 * Purge every account's engine store.
 *
 * Stops the engine first so no in-flight cycle can commit into a namespace that is being
 * removed — the epoch bump inside `purgeAccount` would reject it anyway (§8.3), but
 * aborting is cheaper than letting a cycle run to a rejected commit.
 */
export async function purgeOfflineStores(reason: PurgeReason): Promise<void> {
  stopSyncEngine();
  try {
    for (const accountId of await sqliteStoreFactory.listAccounts()) {
      await sqliteStoreFactory.purgeAccount(accountId, reason);
    }
  } catch (err) {
    console.warn('[sync] purge failed', err);
  }
}
