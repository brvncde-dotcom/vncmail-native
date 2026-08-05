// §10 trigger orchestration: throttles, debounces, T9's progress-gated chaining
// (S8/F46) and §10.4's push handling.
//
// The coordinator's sources are injected, so all of this runs on a fake clock with a
// fake engine — no device, no AppState, no NetInfo, no SSE.

import { describe, expect, it, vi } from 'vitest';

import type { CycleReport, SyncEngine } from '../engine';
import { DEBOUNCE_MS, THROTTLE_MS, TriggerCoordinator, type TriggerDeps } from '../triggers';

const ACCOUNT = 'alice@mail.example';
const JA = 'jmap-acct-1';

interface Fake {
  coordinator: TriggerCoordinator;
  clock: { t: number };
  /** Pending scheduled callbacks, so the test drives time explicitly. */
  timers: Array<{ at: number; fn: () => void }>;
  runDue(): void;
  advance(ms: number): void;
  cycles: Array<{ accountId: string; reason: string }>;
  running: Set<string>;
  wake: string[];
  aborts: string[];
  cursorStates: Record<string, string>;
  nextReport: Partial<CycleReport>;
  logs: string[];
}

function makeFake(): Fake {
  const clock = { t: 1_000_000 };
  const timers: Array<{ at: number; fn: () => void }> = [];
  const cycles: Array<{ accountId: string; reason: string }> = [];
  const running = new Set<string>();
  const wake: string[] = [];
  const aborts: string[] = [];
  const logs: string[] = [];
  const fake: Partial<Fake> = {
    cursorStates: {},
    nextReport: {},
  };

  const engine = {
    isRunning: (accountId: string) => running.has(accountId),
    runCycle: vi.fn(async (accountId: string, reason: string) => {
      cycles.push({ accountId, reason });
      const report: CycleReport = {
        accountId,
        outcome: 'ok',
        madeProgress: true,
        unfinishedWork: false,
        reason,
        startedAt: clock.t,
        finishedAt: clock.t,
        phases: [],
        ...fake.nextReport,
      };
      return report;
    }),
    takeWakeReasons: () => wake.splice(0, wake.length),
    requestAbort: (accountId: string, reason: string) => {
      aborts.push(`${accountId}:${reason}`);
    },
  } as unknown as SyncEngine;

  const deps: TriggerDeps = {
    engine,
    activeAccounts: () => [ACCOUNT],
    jmapAccountIdFor: () => JA,
    cursorState: (_a, type) => fake.cursorStates![type] ?? null,
    now: () => clock.t,
    schedule: (fn, ms) => {
      timers.push({ at: clock.t + ms, fn });
    },
    random: () => 0,
    log: (level, message) => logs.push(`${level}: ${message}`),
  };

  Object.assign(fake, {
    coordinator: new TriggerCoordinator(deps),
    clock,
    timers,
    cycles,
    running,
    wake,
    aborts,
    logs,
    runDue(): void {
      const due = timers.filter((t) => t.at <= clock.t);
      for (const t of due) timers.splice(timers.indexOf(t), 1);
      for (const t of due) t.fn();
    },
    advance(ms: number): void {
      clock.t += ms;
      (fake as Fake).runDue();
    },
  });

  return fake as Fake;
}

describe('§10.1 debounces and throttles', () => {
  it('delays a cold-start trigger by 2 s, keeping today\'s behaviour', () => {
    const f = makeFake();
    f.coordinator.fire('session');
    expect(f.cycles).toEqual([]);
    f.advance(DEBOUNCE_MS.session);
    expect(f.cycles.map((c) => c.reason)).toEqual(['session']);
  });

  it('runs a user-initiated trigger with no debounce and no throttle', () => {
    const f = makeFake();
    // A pull-to-refresh must never be delayed or dropped.
    expect(THROTTLE_MS.manual).toBeNull();
    expect(DEBOUNCE_MS.manual).toBe(0);
    f.coordinator.fire('manual');
    f.advance(0);
    expect(f.cycles.map((c) => c.reason)).toEqual(['manual']);
  });

  it('throttles foreground to once per 30 s', async () => {
    const f = makeFake();
    f.coordinator.fire('foreground');
    f.advance(0);
    await Promise.resolve();
    expect(f.cycles).toHaveLength(1);

    f.coordinator.fire('foreground');
    f.advance(0);
    expect(f.cycles).toHaveLength(1); // suppressed
    expect(f.logs.join('\n')).toMatch(/throttled/);

    f.clock.t += THROTTLE_MS.foreground!;
    f.coordinator.fire('foreground');
    f.advance(0);
    expect(f.cycles).toHaveLength(2);
  });

  it('never throttles a retention change (T6)', () => {
    // The setting change must take effect, not wait out a window.
    expect(THROTTLE_MS.retention).toBeNull();
  });

  it('collapses a burst into one cycle via the debounce', () => {
    const f = makeFake();
    f.coordinator.fire('push');
    f.coordinator.fire('push');
    f.coordinator.fire('push');
    f.advance(DEBOUNCE_MS.push);
    expect(f.cycles).toHaveLength(1);
  });

  it('lets a more urgent reason upgrade a pending trigger instead of queueing', () => {
    const f = makeFake();
    f.coordinator.fire('session'); // 2 s debounce
    f.coordinator.fire('manual'); // 0 s — should win
    f.advance(0);
    expect(f.cycles.map((c) => c.reason)).toEqual(['manual']);
    // And no second cycle when the original debounce would have elapsed.
    f.advance(DEBOUNCE_MS.session);
    expect(f.cycles).toHaveLength(1);
  });

  it('jitters the network-recovery trigger (§7.2 stampede avoidance)', () => {
    const f = makeFake();
    f.coordinator.fire('network');
    // Base debounce is 3 s; with random() = 0 the jitter is 0, so it fires exactly
    // then. The point asserted here is that the delay exists at all.
    f.advance(DEBOUNCE_MS.network - 1);
    expect(f.cycles).toHaveLength(0);
    f.advance(1);
    expect(f.cycles).toHaveLength(1);
  });
});

describe('§10.3 coalescing into a running cycle — D7', () => {
  it('hands the trigger to the running cycle instead of scheduling a new one', () => {
    const f = makeFake();
    f.running.add(ACCOUNT);
    f.coordinator.fire('manual');
    // No timer: the running cycle absorbs it (that was D7 — "Sync now" during a sync
    // produced a cancelled sync and nothing else).
    expect(f.timers).toHaveLength(0);
    expect(f.cycles.map((c) => c.reason)).toEqual(['manual']);
  });
});

describe('T9 chaining — S8/F46', () => {
  it('chains another cycle when work remains AND progress was made', () => {
    const f = makeFake();
    f.coordinator.onCycleFinished({
      accountId: ACCOUNT,
      outcome: 'partial',
      madeProgress: true,
      unfinishedWork: true,
      reason: 'session',
      startedAt: 0,
      finishedAt: 0,
      phases: [],
    });
    expect(f.coordinator.isChaining(ACCOUNT)).toBe(true);
    // Revision 1 had no T9 at all, so a large backlog could stall indefinitely: a
    // user who enables the feature with a big mailbox and stays foregrounded might
    // never get a second cycle.
    f.advance(DEBOUNCE_MS.unfinished);
    expect(f.cycles.map((c) => c.reason)).toEqual(['unfinished']);
  });

  it('STOPS chaining when work remains but no progress was made', () => {
    const f = makeFake();
    f.coordinator.onCycleFinished({
      accountId: ACCOUNT,
      outcome: 'partial',
      madeProgress: false,
      unfinishedWork: true,
      reason: 'unfinished',
      startedAt: 0,
      finishedAt: 0,
      phases: [],
    });
    // The guard S8's fix needs to avoid replacing a stall with a hot loop: a cycle
    // that finishes with work outstanding and no progress is not making headway
    // (server refusing, budget thrash), so a genuine trigger — or §7.7's escalation —
    // takes over.
    expect(f.coordinator.isChaining(ACCOUNT)).toBe(false);
    f.advance(DEBOUNCE_MS.unfinished * 4);
    expect(f.cycles).toHaveLength(0);
    expect(f.logs.join('\n')).toMatch(/hot loop/);
  });

  it('does not chain when there is nothing left to do', () => {
    const f = makeFake();
    f.coordinator.onCycleFinished({
      accountId: ACCOUNT,
      outcome: 'ok',
      madeProgress: true,
      unfinishedWork: false,
      reason: 'session',
      startedAt: 0,
      finishedAt: 0,
      phases: [],
    });
    expect(f.coordinator.isChaining(ACCOUNT)).toBe(false);
    f.advance(60_000);
    expect(f.cycles).toHaveLength(0);
  });

  it('serves a wake reason that arrived mid-cycle immediately', () => {
    const f = makeFake();
    f.wake.push('manual');
    f.coordinator.onCycleFinished({
      accountId: ACCOUNT,
      outcome: 'ok',
      madeProgress: true,
      unfinishedWork: false,
      reason: 'session',
      startedAt: 0,
      finishedAt: 0,
      phases: [],
    });
    f.advance(0);
    expect(f.cycles.map((c) => c.reason)).toEqual(['manual']);
  });
});

describe('§10.4 push handling', () => {
  it('wakes when a pushed state differs from our cursor', () => {
    const f = makeFake();
    f.cursorStates = { Email: 's10', Mailbox: 's10' };
    f.coordinator.onStateChange({ changed: { [JA]: { Email: 's11' } } });
    f.advance(DEBOUNCE_MS.push);
    expect(f.cycles.map((c) => c.reason)).toEqual(['push']);
  });

  it('skips the round-trip when the pushed state EQUALS our cursor', () => {
    // A cheap, safe dedupe: pushed state equal to our cursor means we are already
    // current. Common when our own mutation caused the change.
    const f = makeFake();
    f.cursorStates = { Email: 's11', Mailbox: 's10' };
    f.coordinator.onStateChange({ changed: { [JA]: { Email: 's11' } } });
    f.advance(DEBOUNCE_MS.push * 3);
    expect(f.cycles).toHaveLength(0);
  });

  it('ignores a StateChange for an account that is not ours', () => {
    const f = makeFake();
    f.cursorStates = { Email: 's10' };
    f.coordinator.onStateChange({ changed: { 'someone-elses-account': { Email: 's99' } } });
    f.advance(DEBOUNCE_MS.push * 3);
    expect(f.cycles).toHaveLength(0);
  });

  it('treats EmailDelivery as a bare wake signal', () => {
    // There is no `EmailDelivery/changes`; it is a push type only.
    const f = makeFake();
    f.cursorStates = { Email: 's10', Mailbox: 's10' };
    f.coordinator.onStateChange({ changed: { [JA]: { EmailDelivery: 'whatever' } } });
    f.advance(DEBOUNCE_MS.push);
    expect(f.cycles).toHaveLength(1);
  });

  it('ignores types we hold no cursor for', () => {
    const f = makeFake();
    f.cursorStates = { Email: 's10', Mailbox: 's10' };
    f.coordinator.onStateChange({ changed: { [JA]: { Thread: 's50', Calendar: 's7' } } });
    f.advance(DEBOUNCE_MS.push * 3);
    expect(f.cycles).toHaveLength(0);
  });

  it('never gives the pushed newState to the engine as a cursor', () => {
    // The most tempting wrong optimisation in the design: the pushed state is the
    // server's CURRENT state; ours is our LAST APPLIED state. Assigning it would skip
    // every change in between — permanently, silently, and precisely for the mail the
    // push was announcing. The coordinator's only output is a REASON STRING, so it is
    // structurally incapable of doing this.
    const f = makeFake();
    f.cursorStates = { Email: 's10' };
    f.coordinator.onStateChange({ changed: { [JA]: { Email: 's999' } } });
    f.advance(DEBOUNCE_MS.push);
    expect(f.cycles).toEqual([{ accountId: ACCOUNT, reason: 'push' }]);
    for (const cycle of f.cycles) expect(cycle.reason).not.toContain('s999');
  });
});

describe('T10 and abort conditions', () => {
  it('aborts and stops chaining when offline caching is disabled', () => {
    const f = makeFake();
    f.coordinator.fire('session');
    f.coordinator.onFeatureDisabled(ACCOUNT);
    // The pending trigger is dropped, so the purge is not immediately followed by a
    // cycle that would re-materialise the store (§9.5).
    f.advance(DEBOUNCE_MS.session * 3);
    expect(f.cycles).toHaveLength(0);
    expect(f.aborts.join()).toMatch(/disabled/);
    expect(f.coordinator.isChaining(ACCOUNT)).toBe(false);
  });

  it('aborts on an account switch and cancels the pending trigger', () => {
    const f = makeFake();
    f.coordinator.fire('foreground');
    f.coordinator.onAbortCondition(ACCOUNT, 'account switch');
    f.advance(60_000);
    expect(f.cycles).toHaveLength(0);
    expect(f.aborts.join()).toMatch(/account switch/);
  });
});
