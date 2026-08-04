// Background sync that fills the offline mail cache. Runs the discovery
// query (Email/query filtered by `after`), then fetches full bodies in
// batches, reporting progress to the offline-cache-store so the
// OfflineCacheBanner and the Settings screen can show live updates.

import { jmapClient } from '../api/jmap-client';
import { queryEmailsByFilter, getFullEmails, getEmails } from '../api/email';
import { useOfflineCacheStore } from '../stores/offline-cache-store';
import type { Email } from '../api/types';

// Approximate the on-disk size of a serialised Email so we can show "Y MB
// downloaded" without measuring AsyncStorage usage. Body values dominate; the
// envelope is small. Using JSON.stringify().length is correct in code-units
// not bytes, but it's close enough for a UI-facing estimate.
function approxSize(email: Email): number {
  try {
    return JSON.stringify(email).length;
  } catch {
    return 0;
  }
}

// Hard cap so a misconfigured "30 days" against a noisy account doesn't try
// to enumerate 100k messages.
const DISCOVERY_LIMIT = 5000;
// Each Email/get request is bounded by the server's maxObjectsInGet. We
// further chunk to keep individual responses small (a 50-message response
// with full bodies + body values is already several MB).
const FETCH_CHUNK_FALLBACK = 25;

export interface RunOptions {
  days: number;
  /** Hard cap on the cache in megabytes; oldest mail is evicted to fit. */
  maxMB?: number;
}

export async function runOfflineSync(opts: RunOptions): Promise<void> {
  const cache = useOfflineCacheStore.getState();
  // If a sync is already in flight, leave it alone: it will pick up any mail
  // the user is waiting for. Cancelling it here would abandon an
  // already-paid-for fetch and start over, and the caller has no way to
  // queue a follow-up run — so a redundant call is just a no-op.
  if (cache.sync.phase === 'scanning' || cache.sync.phase === 'fetching') {
    return;
  }
  if (!cache.hydrated) await cache.hydrate();
  cache.resetSync();

  // Pin the account this run is syncing for. `jmapClient.accountId` reflects
  // whatever account is *currently* connected, which can change mid-run if
  // the user switches accounts — every JMAP call below must keep targeting
  // this snapshot, not wherever the client ends up pointing.
  const syncAccountId = jmapClient.accountId;
  const accountChanged = () =>
    useOfflineCacheStore.getState().activeAccountId !== syncAccountId ||
    jmapClient.accountId !== syncAccountId;

  const startedAt = Date.now();
  cache.setSyncState({ phase: 'scanning', startedAt });

  const since = new Date(startedAt - opts.days * 24 * 60 * 60 * 1000).toISOString();

  let ids: string[] = [];
  try {
    ids = await queryEmailsByFilter({ after: since }, DISCOVERY_LIMIT, syncAccountId);
  } catch (err) {
    cache.setSyncState({
      phase: 'error',
      message: err instanceof Error ? err.message : 'Discovery query failed',
      finishedAt: Date.now(),
    });
    return;
  }

  // The account may have switched while the discovery query was in flight.
  // `ids` and everything derived from them below belong to `syncAccountId`;
  // touching the (now different) active account's index with them would
  // wrongly evict or report against its cache. Bail out like a cancellation.
  if (accountChanged()) {
    cache.setSyncState({ phase: 'cancelled', finishedAt: Date.now() });
    return;
  }

  // Drop entries from the cache that fell out of the lookback window — the
  // user expects the cache to track "the last X days", not grow forever.
  const keepSet = new Set(ids);
  const stale = Object.keys(cache.index.entries).filter((id) => !keepSet.has(id));
  if (stale.length > 0) {
    await cache.remove(stale);
  }

  const total = ids.length;
  cache.setSyncState({ phase: 'fetching', total, completed: 0, fetched: 0, bytes: 0 });

  // Bodies on disk are immutable per messageId, so already-cached ids skip
  // the (expensive) full body fetch below. But `keywords` and `mailboxIds`
  // are mutable and live in the same cached blob — without refreshing them,
  // read/unread state and folder membership read offline would go stale
  // forever. Refresh just those two properties for already-cached ids.
  const toFetch = ids.filter((id) => !cache.has(id));
  const toRefresh = ids.filter((id) => cache.has(id));

  const chunkSize = Math.min(
    FETCH_CHUNK_FALLBACK,
    Math.max(1, jmapClient.getMaxObjectsInGet()),
  );

  let fetched = 0;
  let bytes = 0;
  let completed = 0;

  for (let i = 0; i < toRefresh.length; i += chunkSize) {
    if (useOfflineCacheStore.getState().consumeAbort() || accountChanged()) {
      cache.setSyncState({
        phase: 'cancelled',
        finishedAt: Date.now(),
      });
      return;
    }

    const chunk = toRefresh.slice(i, i + chunkSize);
    let refreshed: Email[];
    try {
      refreshed = await getEmails(chunk, syncAccountId);
    } catch (err) {
      cache.setSyncState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Refresh failed',
        finishedAt: Date.now(),
      });
      return;
    }

    for (const email of refreshed) {
      await cache.patch(email.id, { keywords: email.keywords, mailboxIds: email.mailboxIds });
    }
    // Ids deleted server-side between query and refresh don't come back;
    // count them as processed so the progress bar still finishes at 100%.
    completed += chunk.length;

    cache.setSyncState({ completed });
  }

  if (toFetch.length === 0) {
    if (opts.maxMB) await cache.evictToFit(opts.maxMB * 1024 * 1024);
    cache.setSyncState({
      phase: 'done',
      finishedAt: Date.now(),
    });
    return;
  }

  for (let i = 0; i < toFetch.length; i += chunkSize) {
    if (useOfflineCacheStore.getState().consumeAbort() || accountChanged()) {
      cache.setSyncState({
        phase: 'cancelled',
        finishedAt: Date.now(),
      });
      return;
    }

    const chunk = toFetch.slice(i, i + chunkSize);
    let emails: Email[];
    try {
      emails = await getFullEmails(chunk, syncAccountId);
    } catch (err) {
      cache.setSyncState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Fetch failed',
        finishedAt: Date.now(),
      });
      return;
    }

    for (const email of emails) {
      const size = approxSize(email);
      await cache.put(email, size);
      fetched += 1;
      bytes += size;
      completed += 1;
    }

    // Some chunked ids may have been deleted server-side between query and
    // fetch — they don't come back. Account for that in the completed count
    // so the progress bar still finishes at 100%.
    completed += chunk.length - emails.length;

    cache.setSyncState({ completed, fetched, bytes });
  }

  // Trim the cache back under its size cap, shedding the oldest mail. Done
  // after fetching so we never evict something we're about to keep.
  if (opts.maxMB) await cache.evictToFit(opts.maxMB * 1024 * 1024);

  cache.setSyncState({
    phase: 'done',
    completed: total,
    fetched,
    bytes,
    finishedAt: Date.now(),
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
