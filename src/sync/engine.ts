// The cycle orchestrator (design §2, §5.1, §6.4, §7.3, §10.3).
//
// Three state machines per account — LOGICALLY independent (separate persisted
// state, separate failure handling, separate budgets) but OPERATIONALLY SERIALISED
// (I11). The review's Part 3 was right that presenting them as fully independent
// invites a future "run bodies in parallel, it's separate state" optimisation that
// would immediately produce orphan bodies, so the coupling is an invariant here, not
// an implementation detail.
//
// §10.5's headless constraint is honoured throughout: no React, no mounted
// component, no Zustand store is required for CORRECTNESS. Progress reporting is an
// optional observer, the retention policy and the clock arrive as inputs, and the
// deadline is checked cooperatively between pages so a background invocation can
// commit and return before the OS budget expires.

import {
  backfillBodies,
  type BodiesContext,
  drainBodyQueue,
  enforceBodyRetention,
} from './bodies';
import {
  adjustForWindow,
  beginReconcile,
  bootstrap,
  type CoverageContext,
  finishReconcile,
  finishScan,
  runScan,
  sweep,
} from './coverage';
import { checkReconcileBudget } from './cursor';
import { drainEmailChanges, drainMailboxChanges, type DrainContext, type DrainResult } from './delta';
import { backoffDelayMs, type BudgetMode } from './errors';
import { createJmapPort, type JmapPort } from './jmap-port';
import { indexPendingOps, type PendingOp } from './overlay';
import {
  computeFloors,
  guardFloorAgainstClockJump,
  type RetentionPolicy,
} from './retention';
import type {
  AccountSyncState,
  CoverageState,
  LastCycle,
  SyncCursor,
  SyncStore,
  SyncStoreFactory,
} from './store';
import { CorruptStateError, EpochMismatchError } from './store';
import type { CursorType, JmapAccountId, LocalAccountId } from './states';

// ─────────────────────────────────────────────────────────────────────────────
// §6.4 Budgets
// ─────────────────────────────────────────────────────────────────────────────

export interface CycleBudget {
  /** Pages per cursor. */
  pagesPerCursor: number;
  /** Wall-clock soft deadline, checked between pages. */
  wallClockMs: number;
  /** Body queue items across C1+C2. */
  bodyItems: number;
  coveragePages: number;
}

export const BUDGETS: Record<BudgetMode, CycleBudget> = {
  foreground: { pagesPerCursor: 40, wallClockMs: 90_000, bodyItems: 200, coveragePages: 25 },
  background: { pagesPerCursor: 8, wallClockMs: 25_000, bodyItems: 20, coveragePages: 5 },
};

export type CycleOutcome = 'ok' | 'partial' | 'failed' | 'abandoned';

export interface CycleReport {
  accountId: LocalAccountId;
  outcome: CycleOutcome;
  /** True when ANY job committed something — drives §10.3's chaining rule. */
  madeProgress: boolean;
  /** True when work remains, so T9 knows to resume (S8). */
  unfinishedWork: boolean;
  reason: string;
  startedAt: number;
  finishedAt: number;
  phases: string[];
  error?: string;
}

export interface EngineDeps {
  factory: SyncStoreFactory;
  port?: JmapPort;
  /** The JMAP account to sync. v1 syncs the primary mail account only (§8.2). */
  jmapAccountIdFor(accountId: LocalAccountId): JmapAccountId | null;
  retentionFor(accountId: LocalAccountId): RetentionPolicy;
  /** §9.5: a disabled account's store is never opened, let alone materialised. */
  isEnabled(accountId: LocalAccountId): boolean;
  /** §7.3: offline is not an error — a cycle does not start. */
  isOnline(): boolean;
  hasLiveSession(): boolean;
  /** Local intent for the overlay's F29 checks. Empty is a valid answer. */
  pendingOpsFor(accountId: LocalAccountId): readonly PendingOp[];
  now?(): number;
  random?(): number;
  log?(level: 'warn' | 'error' | 'info', message: string): void;
  onReport?(report: CycleReport): void;
}

interface InFlight {
  /** Assigned immediately after construction; the control object has to exist first
   *  so `executeCycle` can read `abort` through it. */
  promise?: Promise<CycleReport>;
  abort: boolean;
}

export class SyncEngine {
  private readonly inFlight = new Map<LocalAccountId, InFlight>();
  private readonly wakePending = new Map<LocalAccountId, Set<string>>();
  private readonly port: JmapPort;

  constructor(private readonly deps: EngineDeps) {
    this.port = deps.port ?? createJmapPort();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(level: 'warn' | 'error' | 'info', message: string): void {
    this.deps.log?.(level, message);
  }

  /** Reasons that arrived while a cycle was running, for §10.3's chaining. */
  takeWakeReasons(accountId: LocalAccountId): string[] {
    const set = this.wakePending.get(accountId);
    if (!set) return [];
    this.wakePending.delete(accountId);
    return [...set];
  }

  isRunning(accountId: LocalAccountId): boolean {
    return this.inFlight.has(accountId);
  }

  /** Abort at the next page boundary (§10.3): account switch, logout, T10, background. */
  requestAbort(accountId: LocalAccountId, reason: string): void {
    const running = this.inFlight.get(accountId);
    if (running) {
      running.abort = true;
      this.log('info', `abort requested for ${accountId}: ${reason}`);
    }
  }

  /**
   * §10.3 single-flight with COALESCING, never abort-to-serve.
   *
   * That was defect D7: `runOfflineSync` set the abort flag and returned when called
   * during a run, so tapping "Sync now" mid-sync produced a CANCELLED sync and no
   * new one. Here a second caller records WHY it wanted a cycle and awaits the same
   * promise (F5/F6).
   */
  runCycle(
    accountId: LocalAccountId,
    reason: string,
    mode: BudgetMode = 'foreground',
  ): Promise<CycleReport> {
    const running = this.inFlight.get(accountId);
    if (running?.promise) {
      // Remember WHY, do not abort. Callers await the same promise.
      const set = this.wakePending.get(accountId) ?? new Set<string>();
      set.add(reason);
      this.wakePending.set(accountId, set);
      return running.promise;
    }

    const entry: InFlight = { abort: false };
    this.inFlight.set(accountId, entry);
    const promise = this.executeCycle(accountId, reason, mode, entry).finally(() => {
      this.inFlight.delete(accountId);
    });
    entry.promise = promise;
    return promise;
  }

  private async executeCycle(
    accountId: LocalAccountId,
    reason: string,
    mode: BudgetMode,
    control: InFlight,
  ): Promise<CycleReport> {
    const startedAt = this.now();
    const budget = BUDGETS[mode];
    const deadlineAt = startedAt + budget.wallClockMs;
    const phases: string[] = [];

    const finish = (
      outcome: CycleOutcome,
      madeProgress: boolean,
      unfinishedWork: boolean,
      error?: string,
    ): CycleReport => {
      const report: CycleReport = {
        accountId,
        outcome,
        madeProgress,
        unfinishedWork,
        reason,
        startedAt,
        finishedAt: this.now(),
        phases,
        error,
      };
      this.deps.onReport?.(report);
      return report;
    };

    // §7.3 — offline is NOT an error. No failure counters touched, no error
    // surfaced (OfflineBanner already tells the user). Same for the app
    // backgrounding before a cycle begins (F13).
    if (!this.deps.isOnline() || !this.deps.hasLiveSession()) {
      return finish('abandoned', false, false, undefined);
    }
    if (!this.deps.isEnabled(accountId)) {
      // §9.5: never open the store for a disabled account.
      return finish('abandoned', false, false);
    }
    const jmapAccountId = this.deps.jmapAccountIdFor(accountId);
    if (!jmapAccountId) return finish('abandoned', false, false);

    let store: SyncStore;
    try {
      store = await this.deps.factory.open(accountId);
    } catch (err) {
      return finish('failed', false, false, String(err));
    }

    // I13/F43 — a corrupt state blob is a RESYNC, not an empty cursor set. Falling
    // back to "no cursors" would leave a store full of unverified pre-existing
    // records that no sweep ever visits.
    let state: AccountSyncState;
    try {
      state = await store.loadAccountState();
    } catch (err) {
      if (err instanceof CorruptStateError) {
        this.log('error', `corrupt sync state for ${accountId}; forcing a resync (I13): ${err.message}`);
        try {
          await store.transaction((txn) => txn.patchAccountFlags({ resyncRequired: true }));
        } catch (patchErr) {
          return finish('failed', false, true, String(patchErr));
        }
        state = {
          schemaVersion: 0,
          cursors: [],
          coverage: [],
          resyncRequired: true,
          reconcilesInWindow: 0,
          reconcileWindowStartedAt: 0,
        };
      } else {
        return finish('failed', false, false, String(err));
      }
    }

    const pending = indexPendingOps(this.deps.pendingOpsFor(accountId));
    const policy = this.deps.retentionFor(accountId);
    const rawFloors = computeFloors(policy, startedAt);

    // F44 — clock-jump guard on the retention boundary.
    const guarded = guardFloorAgainstClockJump(rawFloors.envelopeFrom, state.lastWindowFloor, {
      alreadyConfirmed: state.lastWindowFloor === rawFloors.envelopeFrom,
    });
    if (guarded.suppressed && guarded.warning) this.log('warn', guarded.warning);
    const envelopeFrom = guarded.envelopeFrom;
    // The body floor can never be older than the (possibly held) envelope floor.
    const bodyFrom = rawFloors.bodyFrom > envelopeFrom ? rawFloors.bodyFrom : envelopeFrom;

    const shouldAbort = (): boolean =>
      control.abort || !this.deps.isOnline() || !this.deps.isEnabled(accountId);

    const commonCtx = {
      store,
      port: this.port,
      jmapAccountId,
      deadlineAt,
      now: () => this.now(),
      shouldAbort,
      log: (level: 'warn' | 'error' | 'info', message: string) => this.log(level, message),
    };

    let madeProgress = false;
    let worstOutcome: CycleOutcome = 'ok';
    let firstError: string | undefined;
    let unfinishedWork = false;

    // §7.7/S6: for ESCALATION purposes a cycle is `failed` if ANY job failed,
    // regardless of what the others achieved. `lastCycle.outcome` is the WORST
    // outcome across jobs, not the best; `madeProgress` is tracked separately
    // because it drives chaining rather than escalation (F47).
    const record = (outcome: CycleOutcome, progress: boolean, error?: string): void => {
      madeProgress = madeProgress || progress;
      if (error && !firstError) firstError = error;
      const rank: Record<CycleOutcome, number> = { ok: 0, partial: 1, abandoned: 2, failed: 3 };
      if (rank[outcome] > rank[worstOutcome]) worstOutcome = outcome;
    };

    try {
      let coverage = state.coverage.find((c) => c.jmapAccountId === jmapAccountId);

      // ── Bootstrap, if this account has never run ──
      if (!coverage || coverage.phase === 'never-run') {
        phases.push('bootstrap');
        const result = await bootstrap({
          ...commonCtx,
          envelopeFrom,
          bodyFrom,
          pending,
          pageBudget: budget.coveragePages,
        });
        record(
          result.outcome === 'failed' ? 'failed' : 'ok',
          result.madeProgress,
          result.error,
        );
        if (result.outcome === 'failed' || result.outcome === 'aborted') {
          return finish(worstOutcome, madeProgress, true, firstError);
        }
        state = await store.loadAccountState();
        coverage = state.coverage.find((c) => c.jmapAccountId === jmapAccountId);
      }

      // ── A resync mandated earlier and never completed is STICKY (§7.6) ──
      if (state.resyncRequired && coverage && coverage.phase !== 'reconciling') {
        const started = await this.startReconcile(
          store,
          state,
          coverage,
          { ...commonCtx, envelopeFrom, bodyFrom, pending, pageBudget: budget.coveragePages },
        );
        if (started === 'throttled') {
          record('partial', false);
          unfinishedWork = true;
        } else {
          phases.push('reconcile-start');
          record(started === 'failed' ? 'failed' : 'ok', started !== 'failed');
          state = await store.loadAccountState();
          coverage = state.coverage.find((c) => c.jmapAccountId === jmapAccountId);
        }
      }

      // ── §5.1's job order. Delta BEFORE coverage, and the reason is not style ──
      //
      // The hazard is RESURRECTION: coverage's query returns message X, X is
      // destroyed server-side, delta reports it `destroyed`, and if coverage's page
      // were applied AFTER that delete, X returns as a zombie that no future
      // /changes page will ever re-report.
      //
      //   * Coverage AFTER delta (what we do): coverage's query executes after the
      //     delete was applied, and a JMAP query reflects CURRENT server state, so X
      //     cannot come back. Safe.
      //   * Coverage BEFORE delta: coverage applies X while it is still alive; the
      //     later /changes call reports the destroy and we delete it. Also safe.
      //
      // So either ORDER is safe — provided a job's query->apply pair is never
      // interleaved with another job's apply, which is exactly I11. The unsafe
      // configuration is not an ordering choice but CONCURRENCY, and that is what
      // I11 forbids. Mailbox before Email is a genuine preference rather than a
      // correctness dependency: folder rows are what the list UI resolves names and
      // roles against, and §9.3 deliberately has no email->mailbox FK because the two
      // streams are not transactionally coupled.
      const drainCtxBase: Omit<DrainContext, 'pageBudget'> = {
        ...commonCtx,
        bodyFrom,
        pending,
      };

      for (const type of ['Mailbox', 'Email'] as CursorType[]) {
        if (shouldAbort()) {
          record('abandoned', false);
          unfinishedWork = true;
          break;
        }
        const cursor = state.cursors.find(
          (c) => c.type === type && c.jmapAccountId === jmapAccountId,
        );
        if (!cursor) continue;

        phases.push(`delta:${type}`);
        const drain =
          type === 'Mailbox'
            ? await drainMailboxChanges(
                { ...drainCtxBase, pageBudget: budget.pagesPerCursor },
                cursor,
              )
            : await drainEmailChanges(
                { ...drainCtxBase, pageBudget: budget.pagesPerCursor },
                cursor,
              );

        const handled = await this.handleDrainResult(
          store,
          state,
          coverage,
          cursor,
          drain,
          { ...commonCtx, envelopeFrom, bodyFrom, pending, pageBudget: budget.coveragePages },
        );
        record(handled.outcome, drain.madeProgress, drain.error);
        if (handled.unfinished) unfinishedWork = true;
        if (handled.reloadState) {
          state = await store.loadAccountState();
          coverage = state.coverage.find((c) => c.jmapAccountId === jmapAccountId);
        }
      }

      // ── Job B: coverage / reconcile enumeration ──
      if (!shouldAbort() && coverage) {
        const coverageCtx: CoverageContext = {
          ...commonCtx,
          envelopeFrom,
          bodyFrom,
          pending,
          pageBudget: budget.coveragePages,
        };

        // Retention window reconciliation, phase-aware (F23/F23B/F38).
        const adjustment = adjustForWindow(coverage, envelopeFrom);
        if (Object.keys(adjustment.patch).length > 0) {
          if (adjustment.note) this.log('info', adjustment.note);
          await store.transaction((txn) =>
            txn.patchCoverage(jmapAccountId, adjustment.patch),
          );
          state = await store.loadAccountState();
          coverage = state.coverage.find((c) => c.jmapAccountId === jmapAccountId);
        }

        if (coverage && (coverage.phase === 'scanning' || coverage.phase === 'reconciling')) {
          phases.push(`coverage:${coverage.phase}`);
          const stampedAt =
            coverage.phase === 'reconciling'
              ? (coverage.reconcileStampedAt ?? this.now())
              : this.now();
          const scan = await runScan(coverageCtx, coverage, stampedAt);
          record(
            scan.outcome === 'failed' ? 'failed' : scan.outcome === 'partial' ? 'partial' : 'ok',
            scan.madeProgress,
            scan.error,
          );
          if (scan.outcome === 'partial' || scan.outcome === 'aborted') unfinishedWork = true;

          if (scan.outcome === 'complete') {
            const fresh = (await store.loadAccountState()).coverage.find(
              (c) => c.jmapAccountId === jmapAccountId,
            );
            if (fresh) {
              if (fresh.phase === 'reconciling') {
                // §7.6 step 4 — GATED on step 3 completing, and only against the
                // PINNED sweepFloor (S2). This is the branch that made F38 a
                // permanent-data-loss bug before revision 2.
                phases.push('reconcile-sweep');
                const swept = await sweep(coverageCtx, fresh);
                this.log(
                  'info',
                  `reconcile sweep for ${jmapAccountId}: deleted ${swept.deletedNotSeen} unseen + ` +
                    `${swept.deletedBelowFloor} below the pinned floor ${fresh.sweepFloor}`,
                );
                await finishReconcile(coverageCtx, fresh);
              } else {
                await finishScan(coverageCtx, fresh);
              }
              state = await store.loadAccountState();
              coverage = state.coverage.find((c) => c.jmapAccountId === jmapAccountId);
              if (coverage?.phase === 'scanning') unfinishedWork = true;
            }
          }
        }

        if (adjustment.evictBelow) {
          phases.push('retention:narrow');
          await this.evictEnvelopesBelow(store, jmapAccountId, adjustment.evictBelow);
          madeProgress = true;
        }
      }

      // ── Jobs C1 + C2, plus body retention ──
      if (!shouldAbort()) {
        const bodiesCtx: BodiesContext = {
          ...commonCtx,
          bodyFrom,
          maxBodyBytes: rawFloors.maxBodyBytes,
          itemBudget: budget.bodyItems,
          pending,
          backoffMs: (attempts) =>
            backoffDelayMs(attempts, { mode, random: this.deps.random }),
        };

        phases.push('bodies:drain');
        const drained = await drainBodyQueue(bodiesCtx);
        record(drained.error ? 'failed' : 'ok', drained.madeProgress, drained.error);

        // C2 runs even when C1 found nothing: its whole job is noticing envelopes
        // that never had a body enqueued (a widened body window, or a give-up).
        phases.push('bodies:backfill');
        const backfilled = await backfillBodies({
          ...bodiesCtx,
          itemBudget: Math.max(0, budget.bodyItems - drained.fetched),
        });
        record(backfilled.error ? 'failed' : 'ok', backfilled.madeProgress, backfilled.error);
        if (backfilled.enqueued > 0) unfinishedWork = true;

        phases.push('bodies:retention');
        const evicted = await enforceBodyRetention(bodiesCtx);
        record(evicted.error ? 'failed' : 'ok', evicted.madeProgress, evicted.error);
      }

      // Anything left over that T9 should resume on (S8).
      const finalState = await store.loadAccountState();
      unfinishedWork =
        unfinishedWork ||
        finalState.resyncRequired ||
        finalState.cursors.some((c) => c.drainPending) ||
        finalState.coverage.some(
          (c) => c.phase === 'scanning' || c.phase === 'reconciling',
        ) ||
        (await store.takeBodyQueue(1, this.now())).length > 0;

      const lastCycle: LastCycle = {
        startedAt,
        finishedAt: this.now(),
        outcome: worstOutcome,
        madeProgress,
        error: firstError,
      };
      await store.transaction((txn) =>
        txn.patchAccountFlags({
          lastCycle,
          lastWindowFloor: guarded.nextLastWindowFloor,
        }),
      );

      return finish(worstOutcome, madeProgress, unfinishedWork, firstError);
    } catch (err) {
      if (err instanceof EpochMismatchError) {
        // F21/F22: an account switch, logout, purge, clearRecords or feature-disable
        // landed mid-cycle. The commit was rejected, nothing partial landed, and this
        // is a normal abandonment rather than a failure.
        this.log('info', `cycle for ${accountId} abandoned: ${err.message}`);
        return finish('abandoned', madeProgress, true);
      }
      return finish('failed', madeProgress, true, String(err));
    }
  }

  /** §7.6 steps 0–2, subject to §7.6.1's ceiling. */
  private async startReconcile(
    store: SyncStore,
    state: AccountSyncState,
    coverage: CoverageState,
    ctx: CoverageContext,
  ): Promise<'started' | 'failed' | 'throttled'> {
    const budget = checkReconcileBudget(state, this.now());
    if (!budget.allowed) {
      // §7.6.1: throttle rather than STOP — a hard stop would trade S10's loop for
      // an I10 wedge. One reconcile per day still converges; the loud log and the
      // persistent UI state are what get a human involved.
      this.log(
        'error',
        `reconcile ceiling hit for ${ctx.jmapAccountId}: ${budget.reconcilesInWindow} in 24h. ` +
          'Throttling to one per day and surfacing "offline mail can\'t stay in sync" (§7.6.1).',
      );
      return 'throttled';
    }
    await store.transaction((txn) =>
      txn.patchAccountFlags({
        reconcilesInWindow: budget.reconcilesInWindow,
        reconcileWindowStartedAt: budget.reconcileWindowStartedAt,
      }),
    );
    const result = await beginReconcile(ctx, coverage);
    return result.outcome === 'failed' ? 'failed' : 'started';
  }

  private async handleDrainResult(
    store: SyncStore,
    state: AccountSyncState,
    coverage: CoverageState | undefined,
    cursor: SyncCursor,
    drain: DrainResult,
    ctx: CoverageContext,
  ): Promise<{ outcome: CycleOutcome; unfinished: boolean; reloadState: boolean }> {
    switch (drain.outcome) {
      case 'ok':
        return { outcome: 'ok', unfinished: false, reloadState: false };
      case 'partial':
        return { outcome: 'partial', unfinished: true, reloadState: false };
      case 'aborted':
        return { outcome: 'abandoned', unfinished: true, reloadState: false };
      case 'failed':
        return { outcome: 'failed', unfinished: true, reloadState: true };
      case 'state-invalid': {
        // §7.6: mark the cursor unusable and set the STICKY resync flag. Records stay
        // READABLE, marked stale — a literal reading of RFC 8620 §5.2 ("invalidate
        // your cache") would empty a user's offline mail exactly when they may be
        // offline and depending on it.
        await store.transaction(async (txn) => {
          await txn.patchCursor(
            { jmapAccountId: cursor.jmapAccountId, type: cursor.type },
            {
              invalidatedAt: this.now(),
              invalidatedReason: drain.invalidReason ?? 'cannotCalculateChanges',
            },
          );
          await txn.patchAccountFlags({ resyncRequired: true });
        });
        this.log(
          'warn',
          `${cursor.type}/${cursor.jmapAccountId} invalidated (${drain.invalidReason}); ` +
            'records stay readable until the reconcile sweep (§7.6)',
        );
        // An invalidation of EITHER cursor type reconciles that JMAP account as a
        // whole — splitting it is not worth the reasoning burden when Mailbox/get is
        // one cheap call.
        if (coverage) {
          const fresh = await store.loadAccountState();
          await this.startReconcile(store, fresh, coverage, ctx);
        }
        return { outcome: 'failed', unfinished: true, reloadState: true };
      }
    }
  }

  /** F23B: evict envelopes (and everything hanging off them) below a narrowed floor. */
  private async evictEnvelopesBelow(
    store: SyncStore,
    jmapAccountId: JmapAccountId,
    floor: string,
  ): Promise<void> {
    for (;;) {
      const rows = await store.queryEnvelopes({
        jmapAccountId,
        receivedBefore: floor,
        limit: 500,
      });
      if (rows.length === 0) break;
      const keys = rows.map((r) => ({ jmapAccountId: r.jmapAccountId, id: r.id }));
      // deleteEmails takes the body, membership and queue rows with it.
      await store.transaction((txn) => txn.deleteEmails(keys));
      if (rows.length < 500) break;
    }
  }
}
