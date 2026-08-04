// §7.1 taxonomy, §7.2 backoff, §7.7 escalation ladder, §7.6.1 reconcile ceiling.
//
// These are the rules that make "no error path can wedge an account" (I10) and "a
// failure never causes silent data loss" true, so they get asserted rather than
// assumed. Two of them encode bugs that survived two review rounds: S7/V2's ladder
// and S6's per-cursor counters.

import { describe, expect, it } from 'vitest';

import { AuthenticationError, RateLimitError } from '../../api/jmap-client';
import {
  BACKOFF_CAP_MS,
  backoffDelayMs,
  classify,
  classifyJmapType,
  movesCursor,
  StateInvalidError,
} from '../errors';
import {
  checkReconcileBudget,
  escalateOnFailure,
  ladder,
  MAX_CONSECUTIVE_FAILURES,
  MAX_RECONCILES_PER_WINDOW,
  RECONCILE_WINDOW_MS,
  resetAfterReconcile,
  resetOnAdvance,
  rung0,
  rungValue,
} from '../cursor';
import type { SyncCursor } from '../store';

function cursor(over: Partial<SyncCursor> = {}): SyncCursor {
  return {
    type: 'Email',
    jmapAccountId: 'jmap-acct-1',
    state: 's10',
    drainPending: false,
    consecutiveFailures: 0,
    maxChangesRung: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('§7.1 error taxonomy', () => {
  it('maps every named method-level error type to its class', () => {
    expect(classifyJmapType('cannotCalculateChanges')).toBe('StateInvalid');
    expect(classifyJmapType('serverUnavailable')).toBe('ServerTransient');
    expect(classifyJmapType('serverFail')).toBe('ServerTransient');
    expect(classifyJmapType('serverPartialFail')).toBe('ServerTransient');
    expect(classifyJmapType('requestTooLarge')).toBe('RequestLimit');
    expect(classifyJmapType('rateLimit')).toBe('RateLimit');
    expect(classifyJmapType('invalidArguments')).toBe('Fatal');
    expect(classifyJmapType('unknownMethod')).toBe('Fatal');
    expect(classifyJmapType('accountNotFound')).toBe('Fatal');
    expect(classifyJmapType('forbidden')).toBe('Fatal');
  });

  it('defaults an UNRECOGNISED type to ServerTransient (F16)', () => {
    // Guessing transient costs a retry; guessing state-invalid costs a full
    // resync; guessing fatal stalls the account. The cheapest wrong answer wins.
    expect(classifyJmapType('somethingNobodyHasSeen')).toBe('ServerTransient');
    expect(classifyJmapType('quantumFluxError')).toBe('ServerTransient');
  });

  it('EXACTLY ONE class moves a cursor', () => {
    const classes = [
      'Transport',
      'RateLimit',
      'ServerTransient',
      'RequestLimit',
      'Auth',
      'Fatal',
      'StateInvalid',
    ] as const;
    expect(classes.filter(movesCursor)).toEqual(['StateInvalid']);
  });

  it('classifies a RateLimitError and carries its Retry-After', () => {
    const c = classify(new RateLimitError(7_000));
    expect(c.class).toBe('RateLimit');
    expect(c.retryAfterMs).toBe(7_000);
    expect(c.retryable).toBe(true);
  });

  it('classifies an AuthenticationError as Auth, never a purge signal (F20)', () => {
    const c = classify(new AuthenticationError('Session expired'));
    expect(c.class).toBe('Auth');
    expect(c.retryable).toBe(false);
    // A server hiccup returning 401 must never delete a user's offline mail, so
    // this must not be StateInvalid.
    expect(movesCursor(c.class)).toBe(false);
  });

  it('classifies transport failures by name and by message', () => {
    const typeError = new TypeError('Network request failed');
    expect(classify(typeError).class).toBe('Transport');
    expect(classify(new Error('fetch failed: ECONNRESET')).class).toBe('Transport');
    expect(classify(new Error('request timed out')).class).toBe('Transport');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classify(abort).class).toBe('Transport');
  });

  it('classifies HTTP statuses from the client-thrown message', () => {
    expect(classify(new Error('JMAP request failed: 503')).class).toBe('ServerTransient');
    expect(classify(new Error('JMAP request failed: 429')).class).toBe('RateLimit');
    expect(classify(new Error('JMAP request failed: 413')).class).toBe('RequestLimit');
    expect(classify(new Error('JMAP request failed: 400')).class).toBe('Fatal');
    expect(classify(new Error('JMAP request failed: 403')).class).toBe('Auth');
  });

  it('recovers the JMAP type from the api layer message shape', () => {
    // The typed-error fix on main throws
    // `Error("Email/changes failed: <type> - <description>")`.
    const c = classify(new Error('Email/changes failed: serverUnavailable - try later'));
    expect(c.class).toBe('ServerTransient');
    expect(c.jmapType).toBe('serverUnavailable');

    const fatal = classify(new Error('Email/changes failed: invalidArguments - bad maxChanges'));
    expect(fatal.class).toBe('Fatal');
    expect(fatal.retryable).toBe(false);
  });

  it('classifies a StateInvalidError with its reason', () => {
    const c = classify(new StateInvalidError('oldStateMismatch'));
    expect(c.class).toBe('StateInvalid');
    expect(c.jmapType).toBe('oldStateMismatch');
  });

  it('treats a non-Error throw as transient rather than fatal', () => {
    expect(classify('something odd').class).toBe('ServerTransient');
  });
});

describe('§7.2 backoff', () => {
  it('is bounded by min(cap, base * 2^attempt)', () => {
    const max = (attempt: number, mode: 'foreground' | 'background') =>
      backoffDelayMs(attempt, { mode, random: () => 0.999999 });
    expect(max(0, 'foreground')).toBeLessThanOrEqual(1_000);
    expect(max(1, 'foreground')).toBeLessThanOrEqual(2_000);
    expect(max(3, 'foreground')).toBeLessThanOrEqual(8_000);
    expect(max(30, 'foreground')).toBeLessThanOrEqual(BACKOFF_CAP_MS.foreground);
    expect(max(30, 'background')).toBeLessThanOrEqual(BACKOFF_CAP_MS.background);
  });

  it('is full-jitter: the floor is zero', () => {
    // Jitter matters because §10 has multiple triggers, up to five accounts, and a
    // network-recovery trigger that fires for everything at once — the exact shape
    // that stampedes one Stalwart instance.
    expect(backoffDelayMs(5, { random: () => 0 })).toBe(0);
  });

  it('never shortens a Retry-After, and never lets one cap a longer delay', () => {
    expect(backoffDelayMs(0, { retryAfterMs: 30_000, random: () => 0 })).toBe(30_000);
    // A long jittered delay is kept even when Retry-After is small: a server asking
    // for a second must not shorten our own longer backoff.
    const long = backoffDelayMs(10, { retryAfterMs: 100, random: () => 0.999999 });
    expect(long).toBeGreaterThan(100);
  });
});

describe('§7.7 maxChanges ladder — S7 and V2', () => {
  it('is monotonically NON-INCREASING for every server value', () => {
    for (const maxObjects of [10, 20, 24, 25, 26, 49, 50, 100, 249, 250, 400, 500, 1000, 5000]) {
      const rungs = ladder(maxObjects);
      for (let i = 1; i < rungs.length; i += 1) {
        expect(
          rungs[i],
          `maxObjectsInGet=${maxObjects}: rung ${i} (${rungs[i]}) must not exceed rung ${i - 1} (${rungs[i - 1]})`,
        ).toBeLessThanOrEqual(rungs[i - 1]);
      }
    }
  });

  it('rung 1 <= rung 0 when the server advertises fewer than 250 — the V2 regression', () => {
    // Revision 2 wrote 250/50/25 as BARE CONSTANTS while clamping only rung 0, so a
    // server advertising maxObjectsInGet = 100 gave rung 0 = 100 and rung 1 = 250:
    // the first retry LARGER than the attempt that just failed, which is S7's defect
    // in a narrower form and actively worsens the likeliest cause (response too large).
    const rungs = ladder(100);
    expect(rungs[0]).toBe(100);
    expect(rungs[1]).toBeLessThanOrEqual(rungs[0]);
    expect(rungs).toEqual([100, 100, 50, 25]);
  });

  it('collapses every rung when the server advertises less than 25', () => {
    // Correct: the ladder then buys nothing and escalation proceeds to reconcile on
    // the counter alone, which is right when batch size was never the problem.
    expect(ladder(20)).toEqual([20, 20, 20, 20]);
    expect(ladder(1)).toEqual([1, 1, 1, 1]);
  });

  it('caps rung 0 at 500 even on a generous server', () => {
    expect(rung0(5000)).toBe(500);
    expect(rungValue(0, 5000)).toBe(500);
    expect(ladder(5000)).toEqual([500, 250, 50, 25]);
  });
});

describe('§7.7 escalation is PER CURSOR — S6/F47', () => {
  it('counts a repeat failure at the same sinceState and shrinks the rung', () => {
    const first = escalateOnFailure(cursor(), 's10');
    expect(first.patch).toEqual({
      consecutiveFailures: 1,
      lastFailedState: 's10',
      maxChangesRung: 1,
    });
    expect(first.escalateToReconcile).toBe(false);

    const second = escalateOnFailure(
      cursor({ consecutiveFailures: 1, lastFailedState: 's10', maxChangesRung: 1 }),
      's10',
    );
    expect(second.patch.consecutiveFailures).toBe(2);
    expect(second.patch.maxChangesRung).toBe(2);
  });

  it('restarts the ladder when the failure is at a NEW position', () => {
    // A failure at a different sinceState means we made progress since the last
    // one, so the ladder has nothing to measure.
    const decision = escalateOnFailure(
      cursor({ consecutiveFailures: 3, lastFailedState: 's10', maxChangesRung: 3 }),
      's99',
    );
    expect(decision.patch).toEqual({
      consecutiveFailures: 1,
      lastFailedState: 's99',
      maxChangesRung: 1,
    });
    expect(decision.escalateToReconcile).toBe(false);
  });

  it('escalates to reconcile after MAX_CONSECUTIVE_FAILURES at one position', () => {
    const decision = escalateOnFailure(
      cursor({
        consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1,
        lastFailedState: 's10',
        maxChangesRung: 2,
      }),
      's10',
    );
    expect(decision.escalateToReconcile).toBe(true);
    expect(decision.reason).toMatch(/consecutive failures/);
  });

  it('escalates on a failure AT the smallest rung, without shrinking further', () => {
    const decision = escalateOnFailure(
      cursor({ consecutiveFailures: 2, lastFailedState: 's10', maxChangesRung: 3 }),
      's10',
    );
    expect(decision.escalateToReconcile).toBe(true);
    expect(decision.patch.maxChangesRung).toBe(3);
    expect(decision.reason).toMatch(/smallest maxChanges rung/);
  });

  it('a cursor advance resets that cursor and nothing else (S6)', () => {
    expect(resetOnAdvance()).toEqual({
      consecutiveFailures: 0,
      lastFailedState: undefined,
      maxChangesRung: 0,
    });
  });

  it('one healthy cursor cannot mask another cursor wedging (F47)', () => {
    // The scenario: Mailbox drains cleanly every cycle, Email fails every cycle. A
    // SHARED counter reset by "something succeeded" would never escalate and the
    // Email cursor would never advance again — silently, forever. Because the
    // counters live on SyncCursor, the Email cursor's ladder escalates on schedule.
    let email = cursor({ type: 'Email' });
    const mailbox = cursor({ type: 'Mailbox' });

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
      const decision = escalateOnFailure(email, 's10');
      // The Mailbox cursor succeeding does not touch the Email cursor's state.
      Object.assign(mailbox, resetOnAdvance());
      email = { ...email, ...decision.patch };
      if (decision.escalateToReconcile) {
        expect(i).toBeLessThan(MAX_CONSECUTIVE_FAILURES);
        return;
      }
    }
    throw new Error('the Email cursor never escalated — S6 regression');
  });
});

describe('§7.6 step 5 counter reset — V2', () => {
  it('clears the escalation counters as well as the invalidation fields', () => {
    // Revision 2 cleared only invalidated*, so a completed reconcile carried
    // consecutiveFailures: 5 and maxChangesRung: 3 into its FRESH cursor and the very
    // first post-reconcile failure re-escalated immediately — reconcile -> one
    // failure -> reconcile, bounded only by the 4-per-24h ceiling.
    const reset = resetAfterReconcile();
    expect(reset).toEqual({
      consecutiveFailures: 0,
      lastFailedState: undefined,
      maxChangesRung: 0,
      invalidatedAt: undefined,
      invalidatedReason: undefined,
    });

    // And the proof that it matters: a cursor carrying 5 failures escalates on the
    // very next failure, whereas a reset one does not.
    const carried = escalateOnFailure(
      cursor({ consecutiveFailures: 5, lastFailedState: 's10', maxChangesRung: 3 }),
      's10',
    );
    expect(carried.escalateToReconcile).toBe(true);

    const fresh = escalateOnFailure(cursor({ ...reset, state: 'sFresh' }), 'sFresh');
    expect(fresh.escalateToReconcile).toBe(false);
  });
});

describe('§7.6.1 reconcile ceiling — S10/F39', () => {
  const T0 = 1_770_000_000_000;

  it('allows reconciles up to the ceiling', () => {
    let state = { reconcilesInWindow: 0, reconcileWindowStartedAt: T0 };
    for (let i = 1; i <= MAX_RECONCILES_PER_WINDOW; i += 1) {
      const budget = checkReconcileBudget(state, T0 + 1_000);
      expect(budget.allowed).toBe(true);
      expect(budget.reconcilesInWindow).toBe(i);
      state = {
        reconcilesInWindow: budget.reconcilesInWindow,
        reconcileWindowStartedAt: budget.reconcileWindowStartedAt,
      };
    }
  });

  it('THROTTLES rather than stops once the ceiling is hit', () => {
    // A hard stop would trade S10's loop for an I10 wedge. One reconcile per day
    // still converges; the loud log and the UI state are what get a human involved.
    const budget = checkReconcileBudget(
      { reconcilesInWindow: MAX_RECONCILES_PER_WINDOW, reconcileWindowStartedAt: T0 },
      T0 + 1_000,
    );
    expect(budget.allowed).toBe(false);
    expect(budget.throttled).toBe(true);
  });

  it('opens a fresh window after 24 h, so throttling is never permanent (I10)', () => {
    const budget = checkReconcileBudget(
      { reconcilesInWindow: 99, reconcileWindowStartedAt: T0 },
      T0 + RECONCILE_WINDOW_MS,
    );
    expect(budget.allowed).toBe(true);
    expect(budget.reconcilesInWindow).toBe(1);
    expect(budget.reconcileWindowStartedAt).toBe(T0 + RECONCILE_WINDOW_MS);
  });
});
