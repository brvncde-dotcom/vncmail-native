// The offline read path the UI actually calls (§12.3 items 1-3).
//
// Two jobs, and they are separable on purpose:
//
//  1. THE OVERLAY (§5.6). Applied unconditionally, to whichever store the rows came
//     from. The durable store holds server-derived state only; local intent lives in the
//     outbox and is composed in at read time. This is what makes "delta reverts the
//     user's offline change" (F28) unreachable rather than merely guarded.
//
//  2. THE SOURCE SWITCH (§14.2). With `offlineSyncEngineV2` off, rows come from the old
//     `offline-cache-store`; with it on, from the engine's `SyncStore`. Applying the
//     overlay in BOTH cases is deliberate — on the v1 path it is redundant (that path
//     still write-throughs via `patchCache`) but harmless, because every outbox primitive
//     assigns whole state rather than a delta and is therefore idempotent. Keeping one
//     read path for both avoids two subtly different offline behaviours during dogfood.
//
// §9.5's rule is honoured throughout: a disabled account's store is never opened, so
// nothing is materialised for a user who has not enabled the feature.

import { useSettingsStore } from '../stores/settings-store';
import { pendingOpsForOverlay } from '../stores/outbox-store';
import type { Email } from '../api/types';
import {
  applyPendingOps,
  applyPendingOpsToList,
  indexPendingOps,
  type PendingOp,
} from './overlay';
import { envelopeToEmail, withBody } from './read-model';
import { sqliteStoreFactory } from './store-sqlite';
import type { SyncStore, SyncStoreFactory } from './store';
import type { JmapAccountId, LocalAccountId } from './states';

export interface OfflineReadDeps {
  factory?: SyncStoreFactory;
  /** Injected for tests; defaults to the live outbox. */
  pendingOps?: () => PendingOp[];
  engineEnabled?: () => boolean;
  cacheEnabled?: () => boolean;
}

function deps(overrides?: OfflineReadDeps) {
  return {
    factory: overrides?.factory ?? sqliteStoreFactory,
    pendingOps: overrides?.pendingOps ?? pendingOpsForOverlay,
    engineEnabled:
      overrides?.engineEnabled ?? (() => useSettingsStore.getState().offlineSyncEngineV2),
    cacheEnabled:
      overrides?.cacheEnabled ?? (() => useSettingsStore.getState().offlineCacheEnabled),
  };
}

/** True when reads should come from the engine's store rather than the v1 cache. */
export function engineReadsActive(overrides?: OfflineReadDeps): boolean {
  const d = deps(overrides);
  return d.engineEnabled() && d.cacheEnabled();
}

async function openIfMaterialised(
  factory: SyncStoreFactory,
  accountId: LocalAccountId,
): Promise<SyncStore | null> {
  // §9.5: never materialise a store on a READ. `open()` itself creates nothing, but
  // checking first keeps the intent explicit and skips the work entirely for an account
  // that has never synced.
  if (!(await factory.isMaterialised(accountId))) return null;
  return factory.open(accountId);
}

/**
 * §12.3 items 1-2: the list-level offline read, for `selectMailbox`'s cache seed and
 * `refreshEmails`'s offline fallback.
 *
 * Returns `null` when the engine is not the active source, so the caller keeps its
 * existing v1 behaviour rather than silently rendering an empty list.
 */
export async function readMailboxPage(
  accountId: LocalAccountId,
  jmapAccountId: JmapAccountId,
  mailboxId: string,
  limit: number,
  overrides?: OfflineReadDeps,
): Promise<Email[] | null> {
  const d = deps(overrides);
  if (!engineReadsActive(overrides)) return null;
  const store = await openIfMaterialised(d.factory, accountId);
  if (!store) return [];
  const rows = await store.queryEnvelopes({ jmapAccountId, mailboxId, limit });
  return overlayList(rows.map(envelopeToEmail), d.pendingOps());
}

/**
 * §12.3 item 3: the single-message offline read, for `getEmailDetail`'s cached fallback.
 *
 * This is the one revision 2's list missed, and it is the most visible instance of the bug
 * the overlay exists to prevent: opening a message offline after marking it read offline
 * would show it unread again.
 */
export async function readMessage(
  accountId: LocalAccountId,
  jmapAccountId: JmapAccountId,
  emailId: string,
  overrides?: OfflineReadDeps,
): Promise<Email | null> {
  const d = deps(overrides);
  if (!engineReadsActive(overrides)) return null;
  const store = await openIfMaterialised(d.factory, accountId);
  if (!store) return null;
  const key = { jmapAccountId, id: emailId };
  const envelope = await store.getEnvelope(key);
  if (!envelope) return null;
  const body = await store.getBody(key);
  const email = withBody(envelopeToEmail(envelope), body);
  return overlayOne(email, d.pendingOps());
}

// ── The overlay itself, exposed so the v1 read paths can use it too ──

export function overlayOne(email: Email, pending: readonly PendingOp[]): Email | null {
  const index = indexPendingOps(pending);
  return applyPendingOps(email, index.get(email.id));
}

export function overlayList(emails: Email[], pending: readonly PendingOp[]): Email[] {
  return applyPendingOpsToList(emails, indexPendingOps(pending));
}

/** Live pending ops, for the v1 read paths in `email-store`. */
export function livePendingOps(): PendingOp[] {
  return pendingOpsForOverlay();
}
