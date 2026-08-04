// Job B (coverage) and the reconcile of §7.6.
//
// Coverage owns HISTORY. `/changes` structurally never delivers mail that already
// existed when the cursor was created, so coverage is the job that walks the
// envelope window, the job that runs when the window widens, and the bootstrap.
//
// The two things in this file that are load-bearing for data safety:
//
//  * §4.1's ORDER — capture cursors BEFORE enumerating. The cursor is then OLDER
//    than the data, so the first delta cycle re-delivers a handful of changes we
//    already have (harmless, I5) instead of leaving a permanent gap. The opposite
//    order is cheaper and silently loses mail; it must not be "optimised" back in.
//
//  * S2's PINNED SWEEP FLOOR. Without it, a user who widens retention WHILE a
//    reconcile runs (very plausible — the "re-syncing offline mail" banner is
//    exactly what prompts someone to open Settings) makes step 4 sweep against the
//    new, wider floor while step 3 only enumerated the old, narrower one, deleting
//    every record in the gap. Permanently: `coveredFrom` is then set to the wider
//    floor, so coverage believes that range is complete and delta sync cannot
//    re-deliver pre-existing mail.

import { AnchorNotFoundError } from '../api/email';
import { toEnvelopeRow } from './apply';
import { resetAfterReconcile } from './cursor';
import { classify } from './errors';
import type { JmapPort } from './jmap-port';
import { hasPendingDestroy, type PendingIndex } from './overlay';
import { floorMovement } from './retention';
import type {
  BodyQueueEntry,
  CoverageState,
  CursorKey,
  EnvelopeRow,
  RowKey,
  SyncStore,
} from './store';
import {
  mintEnumerationCommitment,
  type CursorType,
  type JmapAccountId,
} from './states';

/** §6.1's page size. Two real bounds replace the old DISCOVERY_LIMIT of 5000. */
export const COVERAGE_PAGE_SIZE = 200;
/** Sweep deletion batch. Bounded so one page's transaction stays small. */
export const SWEEP_BATCH = 500;

export type CoverageOutcome =
  | 'complete'
  | 'scanning'
  | 'partial'
  | 'failed'
  | 'aborted'
  | 'throttled';

export interface CoverageResult {
  outcome: CoverageOutcome;
  pagesApplied: number;
  envelopesSeen: number;
  madeProgress: boolean;
  error?: string;
}

export interface CoverageContext {
  store: SyncStore;
  port: JmapPort;
  jmapAccountId: JmapAccountId;
  /** ISO floor of the ENVELOPE window (already clock-guarded, F44). */
  envelopeFrom: string;
  /** ISO floor of the BODY window, or null to enqueue no bodies. */
  bodyFrom: string | null;
  pending?: PendingIndex;
  pageBudget: number;
  deadlineAt: number;
  now(): number;
  shouldAbort(): boolean;
  log?: (level: 'warn' | 'error' | 'info', message: string) => void;
}

const CURSOR_TYPES: readonly CursorType[] = ['Mailbox', 'Email'];

function log(
  ctx: CoverageContext,
  level: 'warn' | 'error' | 'info',
  message: string,
): void {
  ctx.log?.(level, message);
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.1 Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seeds both cursors and the coverage commitment, then upserts every mailbox.
 *
 * Step 1 (capture) precedes step 3 (scan) deliberately — see the file header. The
 * seeded cursors are LIVE from here: each subsequent cycle runs A1, A2 and only
 * then B (per I11's ordering), so the bootstrap does not block delta sync. That
 * matters now that the envelope window is wide (§2.1).
 *
 * The bootstrap has NO delete sweep — there is nothing local to sweep. Only
 * reconcile sweeps.
 */
export async function bootstrap(ctx: CoverageContext): Promise<CoverageResult> {
  if (!ctx.port.servesAccount(ctx.jmapAccountId)) {
    return { outcome: 'aborted', pagesApplied: 0, envelopesSeen: 0, madeProgress: false };
  }
  try {
    const snapshots = await ctx.port.captureStates(ctx.jmapAccountId);

    await ctx.store.transaction(async (txn) => {
      // ONE commitment for both cursors (§4.1 step 1). `seedCursor` writes the
      // snapshot state AND the coverage row in the same transaction, so a seed is
      // never durable without the durable commitment to enumerate that justifies it.
      for (const type of CURSOR_TYPES) {
        const key: CursorKey = { jmapAccountId: ctx.jmapAccountId, type };
        await txn.seedCursor(
          key,
          mintEnumerationCommitment({
            jmapAccountId: ctx.jmapAccountId,
            snapshot: type === 'Mailbox' ? snapshots.mailbox : snapshots.email,
            targetFrom: ctx.envelopeFrom,
            // Bootstrap pins the floor to the target: there is nothing local to
            // sweep, so the two coincide.
            sweepFloor: ctx.envelopeFrom,
            kind: 'bootstrap',
          }),
        );
      }
    });

    // Step 2: full Mailbox/get. Cheap, always complete, no paging.
    const mailboxes = await ctx.port.getMailboxesFull(ctx.jmapAccountId);
    await ctx.store.transaction((txn) =>
      txn.upsertMailboxes(
        mailboxes.map((m) => ({
          jmapAccountId: ctx.jmapAccountId,
          id: m.originalId ?? m.id,
          name: m.name,
          parentId: m.parentId ?? null,
          role: m.role ?? null,
          sortOrder: m.sortOrder ?? null,
          totalEmails: m.totalEmails ?? null,
          unreadEmails: m.unreadEmails ?? null,
          totalThreads: m.totalThreads ?? null,
          unreadThreads: m.unreadThreads ?? null,
          myRights: m.myRights ?? null,
          isSubscribed: m.isSubscribed ?? true,
        })),
      ),
    );

    return { outcome: 'scanning', pagesApplied: 0, envelopesSeen: 0, madeProgress: true };
  } catch (err) {
    const classified = classify(err);
    log(ctx, 'error', `bootstrap failed (${classified.class}): ${classified.message}`);
    return {
      outcome: 'failed',
      pagesApplied: 0,
      envelopesSeen: 0,
      madeProgress: false,
      error: classified.message,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retention-window reconciliation (F23 / F23B / F38)
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowAdjustment {
  patch: Partial<CoverageState>;
  /** Evict envelopes strictly below this floor (a narrow, F23B). */
  evictBelow?: string;
  note?: string;
}

/**
 * Reconcile the persisted `targetFrom` with the current retention floor.
 *
 * The phase check is S2/F38, and it is the single most consequential branch in this
 * file: during a reconcile a widen must be DEFERRED, never applied, because the
 * sweep is about to run against a floor the enumeration has already covered.
 */
export function adjustForWindow(
  coverage: CoverageState,
  envelopeFrom: string,
): WindowAdjustment {
  const movement = floorMovement(coverage.targetFrom, envelopeFrom);
  if (movement === 'unchanged') return { patch: {} };

  if (coverage.phase === 'reconciling') {
    if (movement === 'widened') {
      // F38: park it. Applying it now would make step 4 delete everything between
      // the old and new floors, permanently.
      return {
        patch: { deferredTargetFrom: envelopeFrom },
        note: `retention widened to ${envelopeFrom} mid-reconcile; deferred to step 5 (F38)`,
      };
    }
    // A narrow mid-reconcile is also deferred: evicting below a floor the sweep is
    // about to use would race the sweep for no benefit.
    return {
      patch: { deferredTargetFrom: envelopeFrom },
      note: `retention narrowed to ${envelopeFrom} mid-reconcile; deferred to step 5`,
    };
  }

  if (movement === 'widened') {
    // F23: not a resync. `targetFrom` moves back and job B scans ascending from
    // the new floor. Cursors untouched (§7.5 rule 7).
    return {
      patch: {
        targetFrom: envelopeFrom,
        sweepFloor: envelopeFrom,
        phase: 'scanning',
        scanCursor: coverage.coveredFrom ? null : coverage.scanCursor,
      },
      note: `envelope window widened to ${envelopeFrom}; resuming the scan (F23)`,
    };
  }

  // F23B: narrowed. Evict below the new floor; coveredFrom follows it.
  return {
    patch: { targetFrom: envelopeFrom, sweepFloor: envelopeFrom, coveredFrom: envelopeFrom },
    evictBelow: envelopeFrom,
    note: `envelope window narrowed to ${envelopeFrom}; evicting below it (F23B)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §6.1 The ascending keyset scan
// ─────────────────────────────────────────────────────────────────────────────

interface ScanPageResult {
  ids: string[];
  /** True when the page was short, i.e. we reached the tail. */
  reachedTail: boolean;
}

async function fetchScanPage(
  ctx: CoverageContext,
  from: string,
  anchor?: string,
): Promise<ScanPageResult> {
  const { ids } = await ctx.port.queryWindow({
    after: from,
    limit: COVERAGE_PAGE_SIZE,
    isAscending: true,
    anchor,
    anchorOffset: anchor ? 1 : undefined,
    accountId: ctx.jmapAccountId,
  });
  return { ids, reachedTail: ids.length < COVERAGE_PAGE_SIZE };
}

/**
 * One coverage cycle's worth of scanning. Resumable: `scanCursor` is a
 * server-provided `receivedAt` (I8), so it is a meaningful resume point after an
 * OS kill (F3).
 *
 * `stampedAt` is what the enumeration writes as each envelope's `cachedAt`. During a
 * reconcile it is the pinned `reconcileStampedAt`, which is what makes the sweep's
 * "not re-seen" predicate work across many cycles.
 */
export async function runScan(
  ctx: CoverageContext,
  coverage: CoverageState,
  stampedAt: number,
): Promise<CoverageResult> {
  let scanCursor = coverage.scanCursor ?? coverage.sweepFloor ?? coverage.targetFrom;
  let budget = ctx.pageBudget;
  let pagesApplied = 0;
  let envelopesSeen = coverage.seen;
  let madeProgress = false;
  let gapMarkers = coverage.gapMarkers ? [...coverage.gapMarkers] : undefined;

  for (;;) {
    if (ctx.shouldAbort()) {
      return { outcome: 'aborted', pagesApplied, envelopesSeen, madeProgress };
    }
    if (budget <= 0 || ctx.now() >= ctx.deadlineAt) {
      return { outcome: 'partial', pagesApplied, envelopesSeen, madeProgress };
    }
    budget -= 1;

    if (!ctx.port.servesAccount(ctx.jmapAccountId)) {
      return { outcome: 'aborted', pagesApplied, envelopesSeen, madeProgress };
    }

    let page: ScanPageResult;
    try {
      page = await fetchScanPage(ctx, scanCursor);
    } catch (err) {
      const classified = classify(err);
      log(ctx, 'warn', `coverage page failed (${classified.class}): ${classified.message}`);
      return {
        outcome: 'failed',
        pagesApplied,
        envelopesSeen,
        madeProgress,
        error: classified.message,
      };
    }

    if (page.ids.length === 0) {
      await commitScanProgress(ctx, { scanCursor, seen: envelopesSeen, gapMarkers });
      return { outcome: 'complete', pagesApplied, envelopesSeen, madeProgress };
    }

    let envelopes: EnvelopeRow[];
    let bodies: BodyQueueEntry[];
    try {
      const fetched = await ctx.port.getEnvelopes(page.ids, ctx.jmapAccountId);
      envelopes = fetched.list.map((e) => ({
        ...toEnvelopeRow(e, ctx.jmapAccountId, stampedAt),
      }));
      bodies = envelopes
        .filter(
          (e) =>
            ctx.bodyFrom !== null &&
            e.receivedAt >= ctx.bodyFrom &&
            !hasPendingDestroy(ctx.pending?.get(e.id)),
        )
        .map((e) => ({
          jmapAccountId: ctx.jmapAccountId,
          emailId: e.id,
          receivedAt: e.receivedAt,
          attempts: 0,
        }));
    } catch (err) {
      const classified = classify(err);
      return {
        outcome: 'failed',
        pagesApplied,
        envelopesSeen,
        madeProgress,
        error: classified.message,
      };
    }

    const maxReceivedAt = envelopes.reduce<string | null>(
      (max, e) => (max === null || e.receivedAt > max ? e.receivedAt : max),
      null,
    );

    // `after` is INCLUSIVE — this is specified, not implementation-defined.
    // RFC 8621 §4.4.1: *"The receivedAt date-time of the Email must be the same or
    // after this date-time to match the condition."* So every page after the first
    // re-returns the boundary message(s); dedupe by id on commit makes that free
    // (I5). But forward progress therefore requires max(receivedAt) STRICTLY
    // greater than scanCursor.
    const madeForwardProgress = maxReceivedAt !== null && maxReceivedAt > scanCursor;

    try {
      await ctx.store.transaction(async (txn) => {
        if (envelopes.length) await txn.upsertEnvelopes(envelopes);
        if (bodies.length) await txn.enqueueBodies(bodies);
        await txn.patchCoverage(ctx.jmapAccountId, {
          scanCursor: madeForwardProgress ? maxReceivedAt : scanCursor,
          seen: envelopesSeen + envelopes.length,
          gapMarkers,
        });
      });
    } catch (err) {
      const classified = classify(err);
      return {
        outcome: 'failed',
        pagesApplied,
        envelopesSeen,
        madeProgress,
        error: classified.message,
      };
    }

    pagesApplied += 1;
    envelopesSeen += envelopes.length;
    madeProgress = true;

    if (page.reachedTail) {
      return { outcome: 'complete', pagesApplied, envelopesSeen, madeProgress };
    }

    if (madeForwardProgress) {
      scanCursor = maxReceivedAt;
      continue;
    }

    // §6.1's no-forward-progress guard: a FULL page whose every row shares one
    // millisecond. In order.
    const recovered = await recoverFromTieCluster(ctx, scanCursor, page.ids);
    if (recovered.kind === 'anchored') {
      scanCursor = recovered.scanCursor;
      continue;
    }
    if (recovered.kind === 'failed') {
      return {
        outcome: 'failed',
        pagesApplied,
        envelopesSeen,
        madeProgress,
        error: recovered.error,
      };
    }

    // Last resort: skip the millisecond, and leave a DURABLE trace so a support
    // question has an answer. This rung can skip messages sharing the boundary
    // millisecond on a conforming server, so it is never normal-path behaviour and
    // is always logged. A >200-message single-millisecond cluster is a corrupt
    // server, not a case to design for.
    const skippedTo = addMs(scanCursor, 1);
    log(
      ctx,
      'warn',
      `coverage scan could not advance past the receivedAt tie cluster at ${scanCursor}; ` +
        `anchor was rejected, skipping 1ms to ${skippedTo} and recording a gap marker (F33)`,
    );
    gapMarkers = [
      ...(gapMarkers ?? []),
      { from: scanCursor, to: skippedTo, reason: 'tie-cluster-skip' as const, at: ctx.now() },
    ];
    scanCursor = skippedTo;
    await commitScanProgress(ctx, { scanCursor, seen: envelopesSeen, gapMarkers });
  }
}

async function commitScanProgress(
  ctx: CoverageContext,
  patch: { scanCursor: string; seen: number; gapMarkers?: CoverageState['gapMarkers'] },
): Promise<void> {
  await ctx.store.transaction((txn) => txn.patchCoverage(ctx.jmapAccountId, patch));
}

type TieRecovery =
  | { kind: 'anchored'; scanCursor: string }
  | { kind: 'anchor-rejected' }
  | { kind: 'failed'; error: string };

/**
 * Guard rung 1: retry the page using the `anchor` / `anchorOffset` arguments of
 * `Foo/query` (RFC 8620 §5.5, inherited by `Email/query` per RFC 8621 §4.4), from
 * the last id of the previous page, for one page, then resume keyset.
 */
async function recoverFromTieCluster(
  ctx: CoverageContext,
  scanCursor: string,
  previousIds: string[],
): Promise<TieRecovery> {
  const anchor = previousIds[previousIds.length - 1];
  if (!anchor) return { kind: 'anchor-rejected' };
  try {
    const anchored = await fetchScanPage(ctx, scanCursor, anchor);
    if (anchored.ids.length === 0) return { kind: 'anchor-rejected' };
    const fetched = await ctx.port.getEnvelopes(anchored.ids, ctx.jmapAccountId);
    const rows = fetched.list.map((e) => toEnvelopeRow(e, ctx.jmapAccountId, ctx.now()));
    const max = rows.reduce<string | null>(
      (acc, r) => (acc === null || r.receivedAt > acc ? r.receivedAt : acc),
      null,
    );
    await ctx.store.transaction(async (txn) => {
      if (rows.length) await txn.upsertEnvelopes(rows);
      if (max !== null && max > scanCursor) {
        await txn.patchCoverage(ctx.jmapAccountId, { scanCursor: max });
      }
    });
    if (max !== null && max > scanCursor) return { kind: 'anchored', scanCursor: max };
    return { kind: 'anchor-rejected' };
  } catch (err) {
    if (err instanceof AnchorNotFoundError) return { kind: 'anchor-rejected' };
    return { kind: 'failed', error: classify(err).message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §7.6 Reconcile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §7.6 steps 0–2. Steps 3–4 are the ordinary scan plus `sweep()`, and step 5 is
 * `finishReconcile()`, so a reconcile spanning many cycles is just "keep scanning"
 * from the engine's point of view (F49).
 *
 * The seeded cursors are LIVE IMMEDIATELY (S9): from step 1 the delta path runs
 * normally, each cycle, alongside the enumeration. Only the SWEEP waits. Revision 1
 * forbade serving `/changes` until the rebuild finished, which — with a wide envelope
 * window — would stall ALL incoming mail for hours.
 */
export async function beginReconcile(
  ctx: CoverageContext,
  coverage: CoverageState | undefined,
): Promise<CoverageResult> {
  if (!ctx.port.servesAccount(ctx.jmapAccountId)) {
    return { outcome: 'aborted', pagesApplied: 0, envelopesSeen: 0, madeProgress: false };
  }
  // Step 0: PIN THE FLOOR. Every later step reads sweepFloor, never a live
  // targetFrom. This is S2.
  const sweepFloor = coverage?.deferredTargetFrom ?? ctx.envelopeFrom;
  // The stamp must be STRICTLY greater than every `cachedAt` already in the store,
  // or the sweep's "not re-seen" predicate silently matches nothing (two writes in
  // the same millisecond, a frozen clock in a test, or a device with coarse timers).
  // Deriving it from the data instead of the clock makes the predicate exact and
  // keeps it clock-independent, per I8.
  const maxCachedAt = await ctx.store.maxEnvelopeCachedAt(ctx.jmapAccountId);
  const stampedAt = Math.max(ctx.now(), maxCachedAt + 1);

  try {
    const snapshots = await ctx.port.captureStates(ctx.jmapAccountId);

    await ctx.store.transaction(async (txn) => {
      // Step 1: fresh cursors, seeded inside a commitment carrying sweepFloor,
      // BEFORE enumerating (§4.1's ordering applies here too).
      for (const type of CURSOR_TYPES) {
        await txn.seedCursor(
          { jmapAccountId: ctx.jmapAccountId, type },
          mintEnumerationCommitment({
            jmapAccountId: ctx.jmapAccountId,
            snapshot: type === 'Mailbox' ? snapshots.mailbox : snapshots.email,
            targetFrom: sweepFloor,
            sweepFloor,
            kind: 'reconcile',
          }),
        );
      }
      await txn.patchCoverage(ctx.jmapAccountId, {
        reconcileStampedAt: stampedAt,
        deferredTargetFrom: undefined,
      });
    });

    // Step 2: full Mailbox/get -> upsert; delete mailbox rows not returned.
    const mailboxes = await ctx.port.getMailboxesFull(ctx.jmapAccountId);
    const returned = new Set(mailboxes.map((m) => m.originalId ?? m.id));
    const existing = await ctx.store.listMailboxes(ctx.jmapAccountId);
    const stale: RowKey[] = existing
      .filter((m) => !returned.has(m.id))
      .map((m) => ({ jmapAccountId: m.jmapAccountId, id: m.id }));

    await ctx.store.transaction(async (txn) => {
      await txn.upsertMailboxes(
        mailboxes.map((m) => ({
          jmapAccountId: ctx.jmapAccountId,
          id: m.originalId ?? m.id,
          name: m.name,
          parentId: m.parentId ?? null,
          role: m.role ?? null,
          sortOrder: m.sortOrder ?? null,
          totalEmails: m.totalEmails ?? null,
          unreadEmails: m.unreadEmails ?? null,
          totalThreads: m.totalThreads ?? null,
          unreadThreads: m.unreadThreads ?? null,
          myRights: m.myRights ?? null,
          isSubscribed: m.isSubscribed ?? true,
        })),
      );
      // Mailbox rows only — never the emails (I7). If the server destroyed the
      // messages too, `Email/changes` reports them destroyed.
      if (stale.length) await txn.deleteMailboxes(stale);
    });

    return { outcome: 'scanning', pagesApplied: 0, envelopesSeen: 0, madeProgress: true };
  } catch (err) {
    const classified = classify(err);
    log(ctx, 'error', `reconcile start failed (${classified.class}): ${classified.message}`);
    return {
      outcome: 'failed',
      pagesApplied: 0,
      envelopesSeen: 0,
      madeProgress: false,
      error: classified.message,
    };
  }
}

export interface SweepResult {
  deletedNotSeen: number;
  deletedBelowFloor: number;
}

/**
 * §7.6 step 4 — gated on step 3 completing, and only against `sweepFloor`.
 *
 * Two clauses, and the second one matters: records older than the pinned floor
 * cannot be verified by an enumeration that only covers the window, so they are
 * deleted rather than kept on faith. Normally retention has already evicted them.
 */
export async function sweep(
  ctx: CoverageContext,
  coverage: CoverageState,
): Promise<SweepResult> {
  const sweepFloor = coverage.sweepFloor ?? coverage.targetFrom;
  const stampedAt = coverage.reconcileStampedAt;
  if (stampedAt === undefined) {
    throw new Error('sweep: no reconcileStampedAt pinned; refusing to delete unverified records');
  }

  let deletedNotSeen = 0;
  for (;;) {
    const stale = await ctx.store.queryEnvelopes({
      jmapAccountId: ctx.jmapAccountId,
      receivedAfter: sweepFloor,
      cachedBefore: stampedAt,
      limit: SWEEP_BATCH,
    });
    if (stale.length === 0) break;
    const keys = stale.map((e) => ({ jmapAccountId: e.jmapAccountId, id: e.id }));
    await ctx.store.transaction((txn) => txn.deleteEmails(keys));
    deletedNotSeen += keys.length;
  }

  let deletedBelowFloor = 0;
  for (;;) {
    const below = await ctx.store.queryEnvelopes({
      jmapAccountId: ctx.jmapAccountId,
      receivedBefore: sweepFloor,
      limit: SWEEP_BATCH,
    });
    if (below.length === 0) break;
    const keys = below.map((e) => ({ jmapAccountId: e.jmapAccountId, id: e.id }));
    await ctx.store.transaction((txn) => txn.deleteEmails(keys));
    deletedBelowFloor += keys.length;
  }

  return { deletedNotSeen, deletedBelowFloor };
}

/**
 * §7.6 step 5, including V2's counter reset.
 *
 * The reset is not cosmetic: revision 2 cleared only `invalidated*`, so a completed
 * reconcile carried `consecutiveFailures: 5` and `maxChangesRung: 3` into its fresh
 * cursor and the very first post-reconcile failure re-escalated immediately —
 * reconcile -> one failure -> reconcile, bounded only by §7.6.1's ceiling.
 */
export async function finishReconcile(
  ctx: CoverageContext,
  coverage: CoverageState,
): Promise<void> {
  const sweepFloor = coverage.sweepFloor ?? coverage.targetFrom;
  const deferred = coverage.deferredTargetFrom;

  await ctx.store.transaction(async (txn) => {
    await txn.patchCoverage(ctx.jmapAccountId, {
      coveredFrom: sweepFloor,
      sweepFloor: undefined,
      reconcileStampedAt: undefined,
      scanCursor: null,
      // A retention change that arrived mid-reconcile is applied NOW, and re-enters
      // 'scanning' so coverage extends to the new floor (S2/F38).
      targetFrom: deferred ?? coverage.targetFrom,
      deferredTargetFrom: undefined,
      phase: deferred ? 'scanning' : 'complete',
    });
    // Sticky until here (§7.6): a reconcile cannot be skipped because some later
    // cycle happened to succeed.
    await txn.patchAccountFlags({ resyncRequired: false });
    for (const type of CURSOR_TYPES) {
      await txn.patchCursor({ jmapAccountId: ctx.jmapAccountId, type }, resetAfterReconcile());
    }
  });

  if (deferred) {
    log(
      ctx,
      'info',
      `reconcile complete; applying the retention change deferred at step 0 (${deferred}) and extending coverage (F38)`,
    );
  }
}

/** §7.6 step 5's completion for a plain (non-reconcile) scan. */
export async function finishScan(
  ctx: CoverageContext,
  coverage: CoverageState,
): Promise<void> {
  const floor = coverage.sweepFloor ?? coverage.targetFrom;
  await ctx.store.transaction((txn) =>
    txn.patchCoverage(ctx.jmapAccountId, {
      coveredFrom: floor,
      scanCursor: null,
      phase: 'complete',
    }),
  );
}
