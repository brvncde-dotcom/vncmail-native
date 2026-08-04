// Trigger orchestration (design §10).
//
// Sources are INJECTED rather than imported: the coordinator owns the throttles, the
// debounces, T9's resume rule and §10.3's chaining, and knows nothing about AppState,
// NetInfo, SSE or Zustand. That is what §10.5 demands ("no dependency on React, a
// mounted component, or a Zustand store for correctness") and it is what makes every
// rule below testable with a fake clock instead of a device.
//
// Wiring these to the real sources lives in the integration stage, deliberately.

import type { CycleReport, SyncEngine } from './engine';
import type { BudgetMode } from './errors';
import type { JmapAccountId, LocalAccountId } from './states';

export type TriggerReason =
  | 'session' // T1 cold start
  | 'foreground' // T2
  | 'manual' // T3 pull-to-refresh / "Sync now"
  | 'network' // T4
  | 'push' // T5
  | 'retention' // T6
  | 'unfinished' // T9
  | 'background'; // T8

/** §10.1's throttles. `null` means "user-initiated, never throttled". */
export const THROTTLE_MS: Record<TriggerReason, number | null> = {
  session: 0,
  foreground: 30_000,
  manual: null,
  network: 0,
  push: 0,
  retention: null,
  unfinished: 0,
  background: 0,
};

/** §10.1's debounces. */
export const DEBOUNCE_MS: Record<TriggerReason, number> = {
  session: 2_000, // keeps today's behaviour (App.tsx:280-282)
  foreground: 0,
  manual: 0,
  network: 3_000, // + per-account jitter, see below
  push: 2_000,
  retention: 0,
  unfinished: 5_000, // T9: 5 s after the previous cycle
  background: 0,
};

/**
 * §7.1's `StateChange` shape (RFC 8620 §7.1):
 * `{ changed: { <jmapAccountId>: { <type>: <newState> } } }`.
 */
export interface StateChange {
  changed: Record<string, Record<string, string>>;
}

export interface TriggerDeps {
  engine: SyncEngine;
  /** Local accounts eligible for sync. v1 syncs only the active one (§10.3). */
  activeAccounts(): readonly LocalAccountId[];
  jmapAccountIdFor(accountId: LocalAccountId): JmapAccountId | null;
  /** Current persisted cursor state for the §10.4 equality check. Null when unknown. */
  cursorState(accountId: LocalAccountId, type: string): string | null;
  now?(): number;
  /** Injected so tests can drive time; defaults to setTimeout. */
  schedule?(fn: () => void, ms: number): void;
  random?(): number;
  log?(level: 'warn' | 'error' | 'info', message: string): void;
}

interface Pending {
  timer: boolean;
  reason: TriggerReason;
  mode: BudgetMode;
}

export class TriggerCoordinator {
  private readonly lastCycleAt = new Map<LocalAccountId, number>();
  private readonly pending = new Map<LocalAccountId, Pending>();
  /** Set while a chained T9 is allowed; cleared when chaining must stop. */
  private readonly chaining = new Set<LocalAccountId>();

  constructor(private readonly deps: TriggerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private schedule(fn: () => void, ms: number): void {
    if (this.deps.schedule) this.deps.schedule(fn, ms);
    else setTimeout(fn, ms);
  }

  private log(level: 'warn' | 'error' | 'info', message: string): void {
    this.deps.log?.(level, message);
  }

  /**
   * Jitter matters because §10 has multiple independent triggers, up to five
   * accounts, and a network-recovery trigger that fires for EVERYTHING at once —
   * exactly the shape that produces a synchronised stampede against one Stalwart
   * instance (§7.2).
   */
  private jitterFor(reason: TriggerReason): number {
    if (reason !== 'network') return 0;
    const random = this.deps.random ?? Math.random;
    return Math.floor(random() * 2_000);
  }

  /** T1–T6, T8. Returns immediately; the cycle runs after the trigger's debounce. */
  fire(reason: TriggerReason, accountId?: LocalAccountId, mode: BudgetMode = 'foreground'): void {
    const accounts = accountId ? [accountId] : this.deps.activeAccounts();
    for (const account of accounts) this.fireOne(reason, account, mode);
  }

  private fireOne(reason: TriggerReason, accountId: LocalAccountId, mode: BudgetMode): void {
    const throttle = THROTTLE_MS[reason];
    if (throttle !== null && throttle > 0) {
      const last = this.lastCycleAt.get(accountId) ?? 0;
      if (this.now() - last < throttle) {
        this.log('info', `${reason} trigger for ${accountId} throttled (${throttle}ms)`);
        return;
      }
    }

    // A running cycle absorbs the trigger via §10.3's coalescing rather than being
    // aborted — that was D7 ("Sync now" during a sync produced a cancelled sync and
    // nothing else).
    if (this.deps.engine.isRunning(accountId)) {
      void this.deps.engine.runCycle(accountId, reason, mode);
      return;
    }

    const existing = this.pending.get(accountId);
    if (existing?.timer) {
      // A more urgent reason upgrades the pending trigger rather than queueing a
      // second timer.
      if (DEBOUNCE_MS[reason] < DEBOUNCE_MS[existing.reason]) {
        this.pending.set(accountId, { timer: true, reason, mode });
      }
      return;
    }

    const delay = DEBOUNCE_MS[reason] + this.jitterFor(reason);
    this.pending.set(accountId, { timer: true, reason, mode });
    this.schedule(() => {
      const current = this.pending.get(accountId);
      this.pending.delete(accountId);
      if (!current) return;
      void this.dispatch(accountId, current.reason, current.mode);
    }, delay);
  }

  private async dispatch(
    accountId: LocalAccountId,
    reason: TriggerReason,
    mode: BudgetMode,
  ): Promise<void> {
    this.lastCycleAt.set(accountId, this.now());
    let report: CycleReport;
    try {
      report = await this.deps.engine.runCycle(accountId, reason, mode);
    } catch (err) {
      this.log('error', `cycle for ${accountId} threw: ${String(err)}`);
      return;
    }
    this.onCycleFinished(report, mode);
  }

  /**
   * §10.3's chaining rule, which is the guard S8's fix needs to avoid replacing a
   * stall with a hot loop.
   *
   * Revision 1 had no T9 at all, so a large backlog could stall indefinitely: nothing
   * re-triggered a cycle purely because the previous one was `partial`, other than a
   * relaunch. A user who enables the feature with a big mailbox and then stays
   * foregrounded reading mail might never get a second cycle (F46).
   *
   * But T9 alone would spin. So: CHAINED CYCLES CONTINUE ONLY WHILE PROGRESS IS BEING
   * MADE. A cycle that finishes with work outstanding and `madeProgress: false` is not
   * making headway (server refusing, budget thrash), so chaining stops and a genuine
   * trigger — or §7.7's escalation — takes over.
   */
  onCycleFinished(report: CycleReport, mode: BudgetMode = 'foreground'): void {
    const accountId = report.accountId;
    const wake = this.deps.engine.takeWakeReasons(accountId);

    if (wake.length > 0) {
      // Something asked for a cycle while this one ran; serve it immediately.
      this.chaining.add(accountId);
      this.fireOne('manual', accountId, mode);
      return;
    }

    if (!report.unfinishedWork) {
      this.chaining.delete(accountId);
      return;
    }

    if (!report.madeProgress) {
      this.chaining.delete(accountId);
      this.log(
        'warn',
        `stopping T9 chaining for ${accountId}: work remains but the last cycle made no ` +
          'progress, so chaining would be a hot loop (§10.3)',
      );
      return;
    }

    this.chaining.add(accountId);
    this.fireOne('unfinished', accountId, mode);
  }

  /** True while T9 is chaining for this account — for assertions and for the UI. */
  isChaining(accountId: LocalAccountId): boolean {
    return this.chaining.has(accountId);
  }

  /**
   * T5 — §10.4. Two load-bearing rules:
   *
   *  * THE PUSHED `newState` IS NEVER WRITTEN AS A CURSOR. It is the server's CURRENT
   *    state; ours is our LAST APPLIED state. Assigning it would skip every change in
   *    between — permanently, silently, and precisely for the mail the push was
   *    announcing. The design calls this the most tempting wrong optimisation in the
   *    whole document, and the type system now refuses it too: nothing here can mint a
   *    `ChangesState`.
   *
   *  * STATE EQUALITY IS A CHEAP, SAFE DEDUPE. A pushed state equal to our cursor
   *    means we are already current, so skip the round-trip. Common when our own
   *    mutation caused the change.
   */
  onStateChange(change: StateChange): void {
    for (const accountId of this.deps.activeAccounts()) {
      const jmapAccountId = this.deps.jmapAccountIdFor(accountId);
      if (!jmapAccountId) continue;
      const types = change.changed[jmapAccountId];
      if (!types) continue; // not one of ours

      let wake = false;
      for (const [type, newState] of Object.entries(types)) {
        if (type === 'EmailDelivery') {
          // A push type only; there is no `EmailDelivery/changes`. Wake signal only.
          wake = true;
          continue;
        }
        if (type !== 'Email' && type !== 'Mailbox') continue;
        if (this.deps.cursorState(accountId, type) !== newState) wake = true;
      }

      if (wake) this.fireOne('push', accountId, 'foreground');
    }
  }

  /** T10 — offline caching disabled: abort, then the caller purges (§8.4). */
  onFeatureDisabled(accountId: LocalAccountId): void {
    this.pending.delete(accountId);
    this.chaining.delete(accountId);
    this.deps.engine.requestAbort(accountId, 'offline caching disabled (T10)');
  }

  /** Account switch / logout / network loss / app background. */
  onAbortCondition(accountId: LocalAccountId, reason: string): void {
    this.pending.delete(accountId);
    this.chaining.delete(accountId);
    this.deps.engine.requestAbort(accountId, reason);
  }
}

// Explicitly NOT a trigger: a periodic foreground timer. T2/T4/T5/T9 cover the
// ground, and `push.ts`'s `startPolling` remains only as a TRANSPORT fallback when
// neither WebSocket nor SSE is available — its state-change events arrive as T5.
//
// Also not triggers (§10.2): opening a mailbox, opening a message, or scrolling.
// Those are `email-store` concerns with their own network paths. The engine must
// never be on the critical path of a UI interaction; if it is, its budgets and
// backoff become user-visible latency.
