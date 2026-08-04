// Regressions from the adversarial code review (H1, H2, M1, M2, M3, L1).
//
// Each of these was written to REPRODUCE the reported bad outcome first, then kept as
// the guard against it. Where the review's diagnosis and mine differ, the test asserts
// what the code actually does and the comment says so.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { drainEmailChanges } from '../delta';
import { SyncEngine, type CycleReport, type EngineDeps } from '../engine';
import { classify } from '../errors';
import { SyncRegistry } from '../registry';
import { SqliteStoreFactory } from '../store-sqlite';
import type { RetentionPolicy } from '../retention';
import type { SyncStore } from '../store';
import { FakeJmapServer } from './fake-jmap';
import { createTestHost } from './sqlite-test-driver';

const ACCOUNT = 'alice@mail.example';
const T0 = Date.parse('2026-08-04T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function isoDaysBefore(days: number): string {
  return new Date(T0 - days * DAY).toISOString();
}

interface Harness {
  host: ReturnType<typeof createTestHost>;
  registry: SyncRegistry;
  factory: SqliteStoreFactory;
  server: FakeJmapServer;
  engine: SyncEngine;
  deps: EngineDeps;
  clock: { t: number };
  logs: string[];
  state: {
    online: boolean;
    session: boolean;
    enabled: boolean;
    policy: RetentionPolicy;
    accounts: Record<string, string>;
  };
  store(id?: string): Promise<SyncStore>;
}

function makeHarness(over: Partial<Harness['state']> = {}): Harness {
  const host = createTestHost();
  const registry = new SyncRegistry();
  const factory = new SqliteStoreFactory(host, registry);
  const server = new FakeJmapServer();
  const clock = { t: T0 };
  const logs: string[] = [];
  const state = {
    online: true,
    session: true,
    enabled: true,
    policy: { envelopeDays: 365, bodyDays: 30, maxBodyMB: 50 } as RetentionPolicy,
    accounts: { [ACCOUNT]: server.accountId },
    ...over,
  };
  const deps: EngineDeps = {
    factory,
    port: server.asPort(),
    // Per-account, not a constant — the review correctly noted the old harness
    // returned the same JMAP id for every local account.
    jmapAccountIdFor: (accountId) => state.accounts[accountId] ?? null,
    retentionFor: () => state.policy,
    isEnabled: () => state.enabled,
    isOnline: () => state.online,
    hasLiveSession: () => state.session,
    pendingOpsFor: () => [],
    now: () => clock.t,
    random: () => 0,
    sleep: async () => undefined,
    log: (level, message) => logs.push(`${level}: ${message}`),
  };
  return {
    host,
    registry,
    factory,
    server,
    engine: new SyncEngine(deps),
    deps,
    clock,
    logs,
    state,
    store: (id = ACCOUNT) => factory.open(id),
  };
}

async function runToQuiescence(h: Harness, maxCycles = 30): Promise<CycleReport[]> {
  const out: CycleReport[] = [];
  for (let i = 0; i < maxCycles; i += 1) {
    const report = await h.engine.runCycle(ACCOUNT, i === 0 ? 'session' : 'unfinished');
    out.push(report);
    if (!report.unfinishedWork) return out;
    if (!report.madeProgress && report.outcome !== 'ok') return out;
  }
  return out;
}

function seed(server: FakeJmapServer, count: number): void {
  server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
  for (let i = 0; i < count; i += 1) {
    server.createEmail({ id: `E${i}`, receivedAt: isoDaysBefore(count - i) });
  }
}

let harness: Harness;

beforeEach(async () => {
  await AsyncStorage.clear();
});

afterEach(() => {
  harness?.host.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// H1 — body-tier terminal states must be durable
// ─────────────────────────────────────────────────────────────────────────────

describe('H1: body terminal states are durable, so nothing resurrects', () => {
  it('gives up permanently after MAX_BODY_ATTEMPTS instead of retrying forever', async () => {
    harness = makeHarness();
    seed(harness.server, 2);
    await runToQuiescence(harness);

    // A body the server will never hand over.
    harness.server.createEmail({ id: 'POISON', receivedAt: isoDaysBefore(1) });
    harness.server.stickyFaults.getBodies = () => new Error('JMAP request failed: 500');

    let calls = 0;
    for (let cycle = 0; cycle < 12; cycle += 1) {
      await harness.engine.runCycle(ACCOUNT, 'unfinished');
      calls = harness.server.calls.getBodies ?? 0;
    }

    // Before the fix, C2's `queryEnvelopes({hasBody:false})` driver could not tell
    // "not fetched yet" from "deliberately not kept", so the give-up dequeue was
    // immediately undone by a fresh `attempts: 0` row — 5 retries per cycle, forever.
    // A bounded total is the whole point of the give-up rule.
    expect(calls).toBeLessThanOrEqual(6);
  });

  it('does not re-fetch a body the server said notFound', async () => {
    harness = makeHarness();
    seed(harness.server, 1);
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    // A local envelope with no server counterpart: /get answers notFound forever.
    await store.transaction((txn) =>
      txn.upsertEnvelopes([
        {
          jmapAccountId: ja,
          id: 'GHOST',
          threadId: null,
          receivedAt: isoDaysBefore(1),
          size: 1,
          subject: null,
          preview: null,
          from: null,
          to: null,
          cc: null,
          hasAttachment: false,
          keywords: {},
          mailboxIds: { inbox: true },
          hasBody: false,
          bodyBytes: 0,
          cachedAt: T0,
        },
      ]),
    );

    const before = harness.server.calls.getBodies ?? 0;
    for (let cycle = 0; cycle < 8; cycle += 1) {
      await harness.engine.runCycle(ACCOUNT, 'unfinished');
    }
    const after = harness.server.calls.getBodies ?? 0;

    // One fetch to learn it is gone; never again. Previously this was one fetch per
    // cycle, forever.
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('does not re-download bodies the MB cap just shed (the download/discard loop)', async () => {
    // The review's worst case: bodies exceeding the cap are evicted, C2 re-enqueues
    // them because they are still inside the body WINDOW, they download again, the cap
    // evicts them again — unbounded data and battery use.
    harness = makeHarness({ policy: { envelopeDays: 365, bodyDays: 90, maxBodyMB: 0 } });
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    for (let i = 0; i < 4; i += 1) {
      harness.server.createEmail({ id: `B${i}`, receivedAt: isoDaysBefore(i + 1) });
    }

    await runToQuiescence(harness);
    const afterFirst = harness.server.calls.getBodies ?? 0;

    for (let cycle = 0; cycle < 8; cycle += 1) {
      await harness.engine.runCycle(ACCOUNT, 'unfinished');
    }
    const afterMore = harness.server.calls.getBodies ?? 0;

    expect(afterMore).toBe(afterFirst);
    const store = await harness.store();
    expect(await store.bodyBytesTotal()).toBe(0);
    // Envelopes always survive — the cap is a body-tier control (§2.1).
    expect(await store.countEnvelopes({ jmapAccountId: harness.server.accountId })).toBe(4);
  });

  it('stops chaining cycles once every wanted body is resolved', async () => {
    // `out.enqueued` used to count entries ATTEMPTED rather than rows actually
    // inserted, and the engine treated any `enqueued > 0` as unfinished work — so the
    // engine chained a new cycle every 5 s for as long as any envelope lacked a body.
    harness = makeHarness({ policy: { envelopeDays: 365, bodyDays: 90, maxBodyMB: 0 } });
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    for (let i = 0; i < 3; i += 1) {
      harness.server.createEmail({ id: `C${i}`, receivedAt: isoDaysBefore(i + 1) });
    }

    const reports = await runToQuiescence(harness);
    const last = reports[reports.length - 1];
    expect(last.unfinishedWork).toBe(false);
    expect(reports.length).toBeLessThan(30);
  });

  it('reports rows INSERTED, not entries attempted (the chaining fuel)', async () => {
    // Direct, because end-to-end this is masked: with zero jitter the retry backoff is
    // 0 ms, so the queue row is immediately due again and legitimately counts as
    // unfinished work either way. The property itself is simple — call C2 twice and the
    // second pass must report nothing enqueued, because `INSERT OR IGNORE` inserted
    // nothing. Reporting the attempted count instead is what made the engine treat
    // every cycle as unfinished for as long as any envelope lacked a body, chaining a
    // new cycle every 5 s indefinitely.
    const { backfillBodies } = await import('../bodies');
    harness = makeHarness();
    seed(harness.server, 1);
    harness.server.createEmail({ id: 'ONCE', receivedAt: isoDaysBefore(1) });
    // Bootstrap only, so the queue is populated but not drained.
    harness.server.stickyFaults.getBodies = () => new Error('JMAP request failed: 503');
    await harness.engine.runCycle(ACCOUNT, 'session');

    const store = await harness.store();
    const ctx = {
      store,
      port: harness.deps.port!,
      jmapAccountId: harness.server.accountId,
      bodyFrom: isoDaysBefore(30),
      maxBodyBytes: 50 * 1024 * 1024,
      itemBudget: 50,
      deadlineAt: T0 + 90_000,
      now: () => harness.clock.t,
      shouldAbort: () => false,
      backoffMs: () => 60_000,
    };

    const first = await backfillBodies(ctx);
    const second = await backfillBodies(ctx);
    // Whatever the first pass inserted, the second inserts nothing new.
    expect(second.enqueued).toBe(0);
    expect(second.madeProgress).toBe(false);
    expect(first.enqueued).toBeGreaterThanOrEqual(0);
  });

  it('does not chain forever when C2 re-enqueues rows that already exist (honest count)', async () => {
    // `out.enqueued` counted entries ATTEMPTED, not rows inserted. Reach the case that
    // exposes it: one transient body failure leaves a queue row with a FUTURE
    // nextAttemptAt, so takeBodyQueue skips it and it contributes no unfinished work —
    // but C2 still sees an envelope without a body and calls enqueueBodies, which
    // inserts nothing. Counting the attempt made the engine chain a cycle every 5 s
    // forever.
    harness = makeHarness();
    seed(harness.server, 1);
    harness.server.createEmail({ id: 'BACKOFF', receivedAt: isoDaysBefore(1) });

    // Fail the first body fetch only; the row is then in backoff.
    harness.server.faults.getBodies = () => new Error('JMAP request failed: 503');
    // Push the clock so nothing is ever due again within this test.
    const reports = await runToQuiescence(harness);

    const last = reports[reports.length - 1];
    expect(last.unfinishedWork).toBe(false);
    expect(reports.length).toBeLessThan(30);
  });

  it('a widened body window still revives a cap-shed body (the self-heal must survive)', async () => {
    // Making terminal states durable must not break C2's legitimate purpose. A body
    // shed by the cap is revivable once the cap allows it again.
    harness = makeHarness({ policy: { envelopeDays: 365, bodyDays: 90, maxBodyMB: 0 } });
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    harness.server.createEmail({ id: 'REVIVE', receivedAt: isoDaysBefore(2) });
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    expect(await store.getBody({ jmapAccountId: ja, id: 'REVIVE' })).toBeNull();

    harness.state.policy = { envelopeDays: 365, bodyDays: 90, maxBodyMB: 50 };
    await runToQuiescence(harness);

    expect(await store.getBody({ jmapAccountId: ja, id: 'REVIVE' })).not.toBeNull();
  });

  it('a give-up is cleared by a reconcile, so a genuine outage self-heals', async () => {
    harness = makeHarness();
    seed(harness.server, 1);
    harness.server.createEmail({ id: 'FLAKY', receivedAt: isoDaysBefore(1) });
    harness.server.stickyFaults.getBodies = () => new Error('JMAP request failed: 500');

    // Drive enough cycles to actually exhaust the attempt budget, advancing the clock
    // past each backoff. Without this the give-up row is never created and the test
    // passes whether or not a reconcile clears anything.
    for (let cycle = 0; cycle < 10; cycle += 1) {
      harness.clock.t += 10 * 60_000;
      await harness.engine.runCycle(ACCOUNT, 'unfinished');
    }

    const store = await harness.store();
    const ja = harness.server.accountId;
    expect(await store.getBody({ jmapAccountId: ja, id: 'FLAKY' })).toBeNull();
    // The durable terminal state must be on disk — that is the thing the reconcile has
    // to clear.
    expect((await store.listBodyGiveUps(ja, 10)).map((k) => k.id)).toContain('FLAKY');

    // Server recovers, and a full rebuild is mandated for unrelated reasons.
    harness.server.stickyFaults.getBodies = null;
    harness.server.expireChangeLog();
    await runToQuiescence(harness);
    expect(await store.listBodyGiveUps(ja, 10)).toEqual([]);

    // A reconcile re-verifies the record set from scratch, so a stale give-up must not
    // outlive it — otherwise a transient outage would permanently deny a body.
    expect(await store.getBody({ jmapAccountId: ja, id: 'FLAKY' })).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H2 — a clock jump must never wipe the store
// ─────────────────────────────────────────────────────────────────────────────

describe('H2: a device clock jump never evicts the offline store', () => {
  it('survives a forward jump across MANY chained cycles, not just the first', async () => {
    harness = makeHarness();
    seed(harness.server, 4);
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(4);

    // The clock jumps a year forward. The old code held the previous floor for ONE
    // cycle but persisted the JUMPED value as lastWindowFloor, so the T9-chained cycle
    // ~5 s later computed a floor within 5 s of the persisted one — under the guard's
    // own threshold — adopted it as legitimate, classified it a retention NARROW, and
    // evicted everything. A clock glitch wiped the store ~5 s after being detected.
    harness.clock.t = T0 + 365 * DAY;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      harness.clock.t += 5_000; // T9's chaining interval
      await harness.engine.runCycle(ACCOUNT, 'unfinished');
    }

    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(4);
    expect(harness.logs.join('\n')).toMatch(/retention floor moved/);
  });

  it('a genuine user retention narrow still evicts (the guard must not block intent)', async () => {
    harness = makeHarness();
    seed(harness.server, 4);
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(4);

    // envelopeDays changes -> intent, not a glitch. Must take effect immediately.
    harness.state.policy = { envelopeDays: 2, bodyDays: 1, maxBodyMB: 50 };
    await runToQuiescence(harness);

    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBeLessThan(4);
  });

  it('adopts a sustained clock change only after it persists, and never by evicting', async () => {
    harness = makeHarness();
    seed(harness.server, 3);
    await runToQuiescence(harness);
    const store = await harness.store();
    const ja = harness.server.accountId;

    // A jump that sticks around for a long time is eventually the truth — but the
    // adoption must not be the thing that deletes mail. New retention applies to what
    // arrives next; existing records are not retroactively purged on the strength of a
    // clock reading.
    harness.clock.t = T0 + 400 * DAY;
    for (let cycle = 0; cycle < 4; cycle += 1) {
      harness.clock.t += 6 * 60 * 60 * 1000; // hours apart, not seconds
      await harness.engine.runCycle(ACCOUNT, 'foreground');
    }
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(3);
  });

  it('defers the reconcile SWEEP while the retention floor is suspect', async () => {
    // The sweep is a delete against the retention floor, so it is subject to the same
    // rule as eviction: a suspect clock reading may not drive deletion. The reconcile
    // stays open and completes on a cycle whose floor is trustworthy.
    harness = makeHarness();
    seed(harness.server, 3);
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;

    harness.server.expireChangeLog();
    harness.server.faults.queryWindow = () => new Error('JMAP request failed: 503');
    await harness.engine.runCycle(ACCOUNT, 'push');
    expect((await store.loadAccountState()).coverage[0].phase).toBe('reconciling');

    // Clock jumps while the rebuild is open.
    harness.clock.t = T0 + 400 * DAY;
    for (let cycle = 0; cycle < 4; cycle += 1) {
      harness.clock.t += 5_000;
      await harness.engine.runCycle(ACCOUNT, 'unfinished');
    }

    expect(harness.logs.join('\n')).toMatch(/deferring the reconcile sweep/);
    // Nothing was deleted, and the rebuild is still pending rather than wrongly closed.
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(3);
    expect((await store.loadAccountState()).resyncRequired).toBe(true);
  });

  it('a backward clock jump does not evict either', async () => {
    harness = makeHarness();
    seed(harness.server, 3);
    await runToQuiescence(harness);
    const store = await harness.store();
    const ja = harness.server.accountId;

    harness.clock.t = T0 - 500 * DAY;
    for (let cycle = 0; cycle < 5; cycle += 1) {
      harness.clock.t += 5_000;
      await harness.engine.runCycle(ACCOUNT, 'unfinished');
    }
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M1 — the tie-cluster path must use the pinned reconcile stamp
// ─────────────────────────────────────────────────────────────────────────────

describe('M1: the reconcile stamp is honoured on every enumeration path', () => {
  it('does not delete envelopes the ANCHOR recovery re-verified during a reconcile', async () => {
    // Reaching `recoverFromTieCluster`'s upsert at all needs a tie cluster LARGER than
    // one coverage page (200) plus a working anchor — with the anchor rejected the
    // function bails before it writes anything, which is why the earlier version of
    // this test could not have caught the bug.
    const { COVERAGE_PAGE_SIZE } = await import('../coverage');
    harness = makeHarness();
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    const sameMs = isoDaysBefore(2);
    const total = COVERAGE_PAGE_SIZE + 5;
    for (let i = 0; i < total; i += 1) {
      harness.server.createEmail({ id: `TC${String(i).padStart(4, '0')}`, receivedAt: sameMs });
    }

    await runToQuiescence(harness);
    const store = await harness.store();
    const ja = harness.server.accountId;
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(total);

    // Now force a reconcile. Its pinned stamp is max(now, maxCachedAt + 1), which with a
    // frozen clock EXCEEDS now — so any row the anchor path stamps with `now` lands
    // below the pin and the sweep deletes a record the enumeration just re-verified
    // against the server. Permanent, and unrecoverable once coveredFrom claims the
    // range complete.
    harness.server.expireChangeLog();
    await runToQuiescence(harness, 60);

    const ids = (await store.queryEnvelopes({ jmapAccountId: ja, limit: 1000 })).map((e) => e.id);
    expect(ids.length).toBe(total);
    expect(ids.sort()).toEqual(harness.server.liveEmailIds());
  });

  it('does not delete envelopes the tie-cluster recovery just re-verified', async () => {
    // `recoverFromTieCluster` stamped with `ctx.now()` rather than the pinned stamp. If
    // the pin ever exceeds `now` — and it does exactly that, since the pin is
    // max(now, maxCachedAt + 1) — those rows land with cached_at < pin and the sweep
    // deletes records the enumeration just verified against the server. Permanent, and
    // unrecoverable once coveredFrom claims the range complete.
    harness = makeHarness();
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    harness.server.disableAnchor();
    harness.server.maxObjectsInGetValue = 2;
    const sameMs = isoDaysBefore(2);
    for (let i = 0; i < 4; i += 1) {
      harness.server.createEmail({ id: `TIE${i}`, receivedAt: sameMs });
    }
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    const beforeReconcile = await store.countEnvelopes({ jmapAccountId: ja });
    expect(beforeReconcile).toBeGreaterThan(0);

    harness.server.expireChangeLog();
    await runToQuiescence(harness);

    // Whatever the tie-cluster guard did, the sweep must not have deleted a record the
    // server still has and the enumeration re-saw.
    const ids = (await store.queryEnvelopes({ jmapAccountId: ja, limit: 100 })).map((e) => e.id);
    expect(ids.sort()).toEqual(harness.server.liveEmailIds());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M2 — rate limiting must not escalate to a reconcile
// ─────────────────────────────────────────────────────────────────────────────

describe('M2: escalation is gated by error class', () => {
  it('never escalates a rate-limited cursor to a full reconcile', async () => {
    // Escalating on RateLimit means the response to a rate-limited server is to issue
    // far MORE requests — a full window re-enumeration.
    harness = makeHarness();
    seed(harness.server, 3);
    await runToQuiescence(harness);

    const store = await harness.store();
    const { RateLimitError } = await import('../../api/jmap-client');
    harness.server.stickyFaults.emailChanges = () => new RateLimitError(30_000);

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await harness.engine.runCycle(ACCOUNT, 'unfinished');
    }

    const state = await store.loadAccountState();
    // resyncRequired would mean we answered rate limiting with a full rebuild.
    expect(state.resyncRequired).toBe(false);
    expect(state.coverage[0].phase).not.toBe('reconciling');
    expect(harness.logs.join('\n')).not.toMatch(/escalating Email/);
  });

  it('never escalates an Auth failure (F20 — must not touch the user\'s mail)', async () => {
    harness = makeHarness();
    seed(harness.server, 2);
    await runToQuiescence(harness);

    const store = await harness.store();
    const { AuthenticationError } = await import('../../api/jmap-client');
    harness.server.stickyFaults.emailChanges = () => new AuthenticationError('Session expired');

    for (let cycle = 0; cycle < 8; cycle += 1) {
      await harness.engine.runCycle(ACCOUNT, 'unfinished');
    }
    const state = await store.loadAccountState();
    expect(state.resyncRequired).toBe(false);
    expect(await store.countEnvelopes({ jmapAccountId: harness.server.accountId })).toBe(2);
  });

  it('still escalates a genuinely stuck ServerTransient cursor (I10 must hold)', async () => {
    harness = makeHarness();
    seed(harness.server, 2);
    await runToQuiescence(harness);

    harness.server.createEmail({ id: 'STUCK', receivedAt: isoDaysBefore(0) });
    harness.server.stickyFaults.emailChanges = () => new Error('JMAP request failed: 500');

    for (let cycle = 0; cycle < 8; cycle += 1) {
      await harness.engine.runCycle(ACCOUNT, 'unfinished');
    }
    // No error path may leave an account permanently unable to progress.
    expect(harness.logs.join('\n')).toMatch(/escalating Email/);
  });

  it('surfaces Retry-After as a delay hint rather than discarding it', async () => {
    const { RateLimitError } = await import('../../api/jmap-client');
    const classified = classify(new RateLimitError(45_000));
    expect(classified.retryAfterMs).toBe(45_000);

    harness = makeHarness();
    seed(harness.server, 2);
    await runToQuiescence(harness);
    harness.server.stickyFaults.emailChanges = () => new RateLimitError(45_000);
    const report = await harness.engine.runCycle(ACCOUNT, 'unfinished');
    // The engine must tell the trigger layer when it is allowed to come back.
    expect(report.retryAfterMs).toBe(45_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M3 — single-flight re-entrancy
// ─────────────────────────────────────────────────────────────────────────────

describe('M3: single-flight survives a re-entrant trigger from onReport', () => {
  it('coalesces a cycle started synchronously from the onReport callback', async () => {
    const host = createTestHost();
    const registry = new SyncRegistry();
    const factory = new SqliteStoreFactory(host, registry);
    const server = new FakeJmapServer();
    const seen: string[] = [];
    let reentered = false;
    let engine: SyncEngine;

    const deps: EngineDeps = {
      factory,
      port: server.asPort(),
      jmapAccountIdFor: () => server.accountId,
      retentionFor: () => ({ envelopeDays: 365, bodyDays: 30, maxBodyMB: 50 }),
      isEnabled: () => true,
      // Force the synchronous early-return path the review identified.
      isOnline: () => false,
      hasLiveSession: () => true,
      pendingOpsFor: () => [],
      now: () => T0,
      onReport: (r) => {
        seen.push(r.reason);
        if (!reentered) {
          reentered = true;
          // Re-entrant call from inside the synchronous report of the first cycle.
          void engine.runCycle(ACCOUNT, 'reentrant');
        }
      },
    };
    engine = new SyncEngine(deps);

    await engine.runCycle(ACCOUNT, 'first');
    // The map must not be left holding a stale entry, and the re-entrant cycle must
    // not have silently replaced the original's bookkeeping.
    expect(engine.isRunning(ACCOUNT)).toBe(false);
    expect(seen).toContain('first');
    host.cleanup();
  });

  it('a stale finally does not evict a newer in-flight entry', async () => {
    harness = makeHarness();
    seed(harness.server, 2);
    // Two overlapping calls: the second must coalesce onto the first, and after both
    // settle the map must be empty rather than holding a ghost.
    const a = harness.engine.runCycle(ACCOUNT, 'first');
    const b = harness.engine.runCycle(ACCOUNT, 'second');
    expect(b).toBe(a);
    await a;
    expect(harness.engine.isRunning(ACCOUNT)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Two-account concurrency (review's vacuous-test finding #4)
// ─────────────────────────────────────────────────────────────────────────────

describe('two accounts really do sync independently', () => {
  it('runs concurrent cycles for two accounts without crossing data', async () => {
    const host = createTestHost();
    const registry = new SyncRegistry();
    const factory = new SqliteStoreFactory(host, registry);
    const serverA = new FakeJmapServer({ accountId: 'jmap-A' });
    const serverB = new FakeJmapServer({ accountId: 'jmap-B' });
    const BOB = 'bob@mail.example';

    serverA.createMailbox({ id: 'inbox', name: 'Inbox' });
    serverA.createEmail({ id: 'A1', receivedAt: isoDaysBefore(1) });
    serverB.createMailbox({ id: 'inbox', name: 'Inbox' });
    serverB.createEmail({ id: 'B1', receivedAt: isoDaysBefore(1) });
    serverB.createEmail({ id: 'B2', receivedAt: isoDaysBefore(2) });

    const jmapFor: Record<string, string> = { [ACCOUNT]: 'jmap-A', [BOB]: 'jmap-B' };
    const portFor: Record<string, ReturnType<FakeJmapServer['asPort']>> = {
      'jmap-A': serverA.asPort(),
      'jmap-B': serverB.asPort(),
    };
    // One port that dispatches on the account it is asked about — so a call issued for
    // A can never be answered by B's data.
    const port = {
      ...portFor['jmap-A'],
      mailboxChanges: (s: string, a: string) => portFor[a].mailboxChanges(s, a),
      emailChanges: (s: string, m: number, a: string) => portFor[a].emailChanges(s, m, a),
      getEnvelopes: (ids: string[], a: string) => portFor[a].getEnvelopes(ids, a),
      getMutable: (ids: string[], a: string) => portFor[a].getMutable(ids, a),
      getBodies: (ids: string[], a: string) => portFor[a].getBodies(ids, a),
      getMailboxesFull: (a: string) => portFor[a].getMailboxesFull(a),
      getMailboxesByIdsFull: (ids: string[], a: string) => portFor[a].getMailboxesByIdsFull(ids, a),
      getMailboxCounts: (ids: string[], a: string) => portFor[a].getMailboxCounts(ids, a),
      queryWindow: (o: { accountId: string; limit: number }) => portFor[o.accountId].queryWindow(o),
      captureStates: (a: string) => portFor[a].captureStates(a),
      servesAccount: () => true,
    } as ReturnType<FakeJmapServer['asPort']>;

    const deps: EngineDeps = {
      factory,
      port,
      jmapAccountIdFor: (accountId) => jmapFor[accountId] ?? null,
      retentionFor: () => ({ envelopeDays: 365, bodyDays: 30, maxBodyMB: 50 }),
      isEnabled: () => true,
      isOnline: () => true,
      hasLiveSession: () => true,
      pendingOpsFor: () => [],
      now: () => T0,
    };
    const engine = new SyncEngine(deps);

    // CONCURRENT, not sequential — single-flight is per account, so these interleave.
    for (let i = 0; i < 5; i += 1) {
      await Promise.all([
        engine.runCycle(ACCOUNT, 'unfinished'),
        engine.runCycle(BOB, 'unfinished'),
      ]);
    }

    const storeA = await factory.open(ACCOUNT);
    const storeB = await factory.open(BOB);
    expect((await storeA.queryEnvelopes({ jmapAccountId: 'jmap-A', limit: 50 })).map((e) => e.id)).toEqual(['A1']);
    expect(
      (await storeB.queryEnvelopes({ jmapAccountId: 'jmap-B', limit: 50 }))
        .map((e) => e.id)
        .sort(),
    ).toEqual(['B1', 'B2']);
    // Neither store holds the other's JMAP account at all.
    expect(await storeA.countEnvelopes({ jmapAccountId: 'jmap-B' })).toBe(0);
    expect(await storeB.countEnvelopes({ jmapAccountId: 'jmap-A' })).toBe(0);
    host.cleanup();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// oldState mismatch: the confirmed:false branch (review's vacuous-test finding #3)
// ─────────────────────────────────────────────────────────────────────────────

describe('a one-shot oldState mismatch is a transient anomaly, not an invalidation', () => {
  it('re-issues, accepts the match, and applies THAT page rather than the first', async () => {
    harness = makeHarness();
    seed(harness.server, 2);
    await runToQuiescence(harness);

    harness.server.createEmail({ id: 'AFTERMATCH', receivedAt: isoDaysBefore(0) });
    harness.server.oldStateMismatchOnce = true;

    const store = await harness.store();
    const state = await store.loadAccountState();
    const before = harness.server.calls.emailChanges ?? 0;

    const result = await drainEmailChanges(
      {
        store,
        port: harness.deps.port!,
        jmapAccountId: harness.server.accountId,
        bodyFrom: isoDaysBefore(30),
        pageBudget: 5,
        deadlineAt: T0 + 90_000,
        now: () => harness.clock.t,
        shouldAbort: () => false,
        log: (l, m) => harness.logs.push(`${l}: ${m}`),
      },
      state.cursors.find((c) => c.type === 'Email')!,
    );

    // The confirm-before-escalate branch: matched on re-issue -> WARN and continue.
    expect(result.outcome).toBe('ok');
    expect(harness.server.calls.emailChanges! - before).toBeGreaterThanOrEqual(2);
    expect(harness.logs.join('\n')).toMatch(/transient server anomaly/);
    // And the page that was actually applied is the RE-ISSUED one, so the change it
    // reported is not skipped — the D4 shape, one level down.
    expect(
      await store.getEnvelope({ jmapAccountId: harness.server.accountId, id: 'AFTERMATCH' }),
    ).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The sweep's own refusal guard (review's vacuous-test finding #2)
// ─────────────────────────────────────────────────────────────────────────────

describe('the sweep refuses to run without a pinned stamp', () => {
  it('throws rather than deleting when reconcileStampedAt is absent', async () => {
    // The highest-blast-radius guard in coverage.ts and it had no test at all: remove
    // the throw and `cachedBefore: undefined` drops the "not re-seen" predicate, so
    // clause 1 deletes EVERY envelope at or above the floor — the whole window, with no
    // protection and nothing to recover from.
    const { sweep } = await import('../coverage');
    harness = makeHarness();
    seed(harness.server, 3);
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    const before = await store.countEnvelopes({ jmapAccountId: ja });
    expect(before).toBe(3);

    const ctx = {
      store,
      port: harness.deps.port!,
      jmapAccountId: ja,
      envelopeFrom: isoDaysBefore(365),
      bodyFrom: isoDaysBefore(30),
      pageBudget: 25,
      deadlineAt: T0 + 90_000,
      now: () => harness.clock.t,
      shouldAbort: () => false,
    };

    await expect(
      sweep(ctx, {
        jmapAccountId: ja,
        coveredFrom: isoDaysBefore(365),
        scanCursor: null,
        targetFrom: isoDaysBefore(365),
        sweepFloor: isoDaysBefore(365),
        // The pin is missing — the caller never began a reconcile properly.
        reconcileStampedAt: undefined,
        phase: 'reconciling',
        seen: 3,
        consecutiveFailures: 0,
        updatedAt: 0,
      }),
    ).rejects.toThrow(/refusing to delete unverified records/);

    // And it refused BEFORE deleting anything, not part-way through.
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(before);
  });

  it('deletes only unseen records when the stamp IS pinned', async () => {
    const { sweep } = await import('../coverage');
    harness = makeHarness();
    seed(harness.server, 3);
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    // Re-stamp two of the three, as an enumeration would.
    const stamp = (await store.maxEnvelopeCachedAt(ja)) + 1;
    const rows = await store.queryEnvelopes({ jmapAccountId: ja, limit: 10 });
    await store.transaction((txn) =>
      txn.upsertEnvelopes(rows.slice(0, 2).map((r) => ({ ...r, cachedAt: stamp }))),
    );

    await sweep(
      {
        store,
        port: harness.deps.port!,
        jmapAccountId: ja,
        envelopeFrom: isoDaysBefore(365),
        bodyFrom: isoDaysBefore(30),
        pageBudget: 25,
        deadlineAt: T0 + 90_000,
        now: () => harness.clock.t,
        shouldAbort: () => false,
      },
      {
        jmapAccountId: ja,
        coveredFrom: isoDaysBefore(365),
        scanCursor: null,
        targetFrom: isoDaysBefore(365),
        sweepFloor: isoDaysBefore(365),
        reconcileStampedAt: stamp,
        phase: 'reconciling',
        seen: 2,
        consecutiveFailures: 0,
        updatedAt: 0,
      },
    );

    // Exactly the two re-seen ones survive — the predicate is a positive verification,
    // not a range subtraction.
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L1 — the narrow branch must not claim coverage it never had
// ─────────────────────────────────────────────────────────────────────────────

describe('L1: a narrow does not claim a range that was never enumerated', () => {
  it('leaves coveredFrom null when the initial scan never completed', async () => {
    const { adjustForWindow } = await import('../coverage');
    const adjustment = adjustForWindow(
      {
        jmapAccountId: 'jmap-A',
        coveredFrom: null, // the first scan never finished
        scanCursor: '2026-07-10T00:00:00Z',
        targetFrom: '2026-07-01T00:00:00Z',
        phase: 'scanning',
        seen: 5,
        consecutiveFailures: 0,
        updatedAt: 0,
      },
      '2026-08-01T00:00:00Z',
    );
    // Claiming coveredFrom here would assert a range is complete that was never
    // walked, and delta sync cannot re-deliver pre-existing mail to fix that.
    expect(adjustment.patch.coveredFrom ?? null).toBeNull();
    expect(adjustment.evictBelow).toBe('2026-08-01T00:00:00Z');
  });
});
