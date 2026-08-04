// The cursor state machine: §7.5's advance rules and §7.7's anti-wedge escalation.
// Pure — decisions in, decisions out; `delta.ts` performs them.

import type { SyncCursor } from './store';

export type MaxChangesRung = 0 | 1 | 2 | 3;

/**
 * §7.7 / V2 — the `maxChanges` ladder, MONOTONICALLY NON-INCREASING for every
 * possible server value.
 *
 * Two corrections are baked in here and both were real bugs in the design:
 *
 *  * S7: revision 1 went 500 -> 250 -> UNBOUNDED, justified by a claimed RFC
 *    ambiguity that neither the reviewer nor the author could substantiate against
 *    RFC 8620 §5.2. Worse, removing the bound makes the retry strictly LARGER than
 *    the attempt that just failed, which actively worsens the likeliest real cause
 *    (response too large). The unbounded rung is gone.
 *
 *  * V2: revision 2 then clamped only rung 0 with `min(maxObjectsInGet, 500)` and
 *    left 250/50/25 as bare constants. `getMaxObjectsInGet()` returns
 *    `core?.maxObjectsInGet || 500`, so a server advertising 100 gives rung 0 = 100
 *    and rung 1 = 250 — the first retry LARGER than the attempt that just failed,
 *    i.e. S7's defect in a narrower form. Every rung is now expressed relative to
 *    rung 0.
 */
export function rung0(maxObjectsInGet: number): number {
  return Math.min(maxObjectsInGet, 500);
}

export function rungValue(rung: MaxChangesRung, maxObjectsInGet: number): number {
  const base = rung0(maxObjectsInGet);
  switch (rung) {
    case 0:
      return base;
    case 1:
      return Math.min(base, 250);
    case 2:
      return Math.min(base, 50);
    case 3:
      return Math.min(base, 25);
  }
}

/**
 * The whole ladder, for assertions and logging. On a server with a small
 * `maxObjectsInGet` some rungs collapse to the same value (at 20, all four rungs
 * are 20). That is correct: the ladder then buys nothing and escalation proceeds to
 * reconcile on the counter alone, which is the right outcome when the batch size
 * was never the problem.
 */
export function ladder(maxObjectsInGet: number): number[] {
  return ([0, 1, 2, 3] as MaxChangesRung[]).map((r) => rungValue(r, maxObjectsInGet));
}

/** §7.7: escalate to reconcile after this many consecutive failures at one position. */
export const MAX_CONSECUTIVE_FAILURES = 5;

export interface EscalationDecision {
  /** What to write to the cursor's counters. */
  patch: {
    consecutiveFailures: number;
    lastFailedState?: string;
    maxChangesRung: MaxChangesRung;
  };
  /** True when the cursor must go to StateInvalid and reconcile (§7.6). */
  escalateToReconcile: boolean;
  reason?: string;
}

/**
 * §7.7 — per-CURSOR escalation (S6's fix).
 *
 * Revision 1 kept `consecutiveFailures` / `lastFailedState` as scalars on
 * `AccountSyncState`, while cursors are per-type. If `Mailbox` drains cleanly every
 * cycle and `Email` fails every cycle, a shared counter reset by "something
 * succeeded" never escalates, and the Email cursor never advances again —
 * silently, forever. That is exactly the wedge I10 exists to make unreachable
 * (F47).
 *
 * Escalation is counted ONLY when the failure recurs at the SAME position: a
 * failure at a new `sinceState` means we made progress since the last one, so the
 * ladder restarts.
 */
export function escalateOnFailure(cursor: SyncCursor, failedState: string): EscalationDecision {
  const sameSpot = cursor.lastFailedState === failedState;
  const consecutiveFailures = sameSpot ? cursor.consecutiveFailures + 1 : 1;
  const currentRung: MaxChangesRung = sameSpot ? cursor.maxChangesRung : 0;

  // A failure AT rung 3 is terminal for the ladder — there is no smaller batch to
  // try, so shrinking further would just burn cycles.
  if (currentRung >= 3 || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      patch: { consecutiveFailures, lastFailedState: failedState, maxChangesRung: currentRung },
      escalateToReconcile: true,
      reason:
        currentRung >= 3
          ? `failure at the smallest maxChanges rung after ${consecutiveFailures} attempts`
          : `${consecutiveFailures} consecutive failures at the same sinceState`,
    };
  }

  const nextRung = (currentRung + 1) as MaxChangesRung;
  return {
    patch: { consecutiveFailures, lastFailedState: failedState, maxChangesRung: nextRung },
    escalateToReconcile: false,
  };
}

/**
 * Any cycle in which THIS cursor advances resets its counters and rung to 0
 * (§7.7). Success on another cursor never resets this one — that is S6.
 */
export function resetOnAdvance(): {
  consecutiveFailures: number;
  lastFailedState: undefined;
  maxChangesRung: MaxChangesRung;
} {
  return { consecutiveFailures: 0, lastFailedState: undefined, maxChangesRung: 0 };
}

/**
 * §7.6 step 5 / V2 — a completed reconcile resets the escalation counters, not just
 * the invalidation fields.
 *
 * Revision 2 cleared only `invalidated*`, which left a completed reconcile carrying
 * `consecutiveFailures: 5` and `maxChangesRung: 3` into its FRESH cursor: the very
 * first post-reconcile failure would satisfy `consecutiveFailures >= 5` and
 * immediately re-escalate, so the account would ping-pong
 * reconcile -> one failure -> reconcile, bounded only by §7.6.1's ceiling.
 *
 * A successful reconcile is by definition a clean position — a fresh cursor at a
 * fresh state, with the record set verified against it — so the failure history
 * belongs to the OLD cursor and carrying it forward measures nothing.
 */
export function resetAfterReconcile(): {
  consecutiveFailures: number;
  lastFailedState: undefined;
  maxChangesRung: MaxChangesRung;
  invalidatedAt: undefined;
  invalidatedReason: undefined;
} {
  return {
    consecutiveFailures: 0,
    lastFailedState: undefined,
    maxChangesRung: 0,
    invalidatedAt: undefined,
    invalidatedReason: undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §7.6.1 reconcile ceiling (S10's fix)
// ─────────────────────────────────────────────────────────────────────────────

export const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_RECONCILES_PER_WINDOW = 4;

export interface ReconcileBudget {
  allowed: boolean;
  reconcilesInWindow: number;
  reconcileWindowStartedAt: number;
  throttled: boolean;
}

/**
 * §7.6.1: a server that echoes a semantically-equal but non-byte-identical
 * `oldState` would otherwise trip EVERY cycle, reconcile, seed a fresh cursor and
 * trip again — unbounded full-window rescans that `consecutiveFailures` never
 * catches, because each reconcile "succeeds".
 *
 * THROTTLING rather than stopping is deliberate: a hard stop would trade S10's loop
 * for an I10 wedge. One reconcile per day still converges; the loud log and the
 * persistent UI state are what get a human involved.
 */
export function checkReconcileBudget(
  state: { reconcilesInWindow: number; reconcileWindowStartedAt: number },
  now: number,
): ReconcileBudget {
  const windowExpired = now - state.reconcileWindowStartedAt >= RECONCILE_WINDOW_MS;
  if (windowExpired) {
    return {
      allowed: true,
      reconcilesInWindow: 1,
      reconcileWindowStartedAt: now,
      throttled: false,
    };
  }
  if (state.reconcilesInWindow >= MAX_RECONCILES_PER_WINDOW) {
    return {
      allowed: false,
      reconcilesInWindow: state.reconcilesInWindow,
      reconcileWindowStartedAt: state.reconcileWindowStartedAt,
      throttled: true,
    };
  }
  return {
    allowed: true,
    reconcilesInWindow: state.reconcilesInWindow + 1,
    reconcileWindowStartedAt: state.reconcileWindowStartedAt,
    throttled: false,
  };
}
