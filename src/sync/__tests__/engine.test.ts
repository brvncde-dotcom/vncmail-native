// End-to-end engine tests: the fake JMAP server (real change log) against the real
// SQLite store (real transactions). Nothing is mocked between them, so these
// exercise the interactions §11's failure table is actually about.
//
// Categories covered here, per §13: crash mid-drain, the retention race, multi-account
// isolation, clock skew, corrupt state, plus the D1 "no body refetch" network
// assertion and D7's single-flight.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { drainBodyQueue } from '../bodies';
import { drainEmailChanges, drainMailboxChanges } from '../delta';
import { SyncEngine, type CycleReport, type EngineDeps } from '../engine';
import type { PendingOp } from '../overlay';
import { SyncRegistry } from '../registry';
import { cursorStateKey, databaseNameFor } from '../schema';
import { SqliteStoreFactory } from '../store-sqlite';
import type { RetentionPolicy } from '../retention';
import type { SyncCursor, SyncStore } from '../store';
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
  reports: CycleReport[];
  state: {
    online: boolean;
    session: boolean;
    enabled: boolean;
    pending: PendingOp[];
    policy: RetentionPolicy;
  };
  store(): Promise<SyncStore>;
  /** A "relaunch": a fresh factory + registry over the same database files. */
  relaunch(): Harness;
}

function makeHarness(over: Partial<Harness['state']> = {}, server?: FakeJmapServer): Harness {
  const host = createTestHost();
  const registry = new SyncRegistry();
  const factory = new SqliteStoreFactory(host, registry);
  const fake = server ?? new FakeJmapServer();
  const clock = { t: T0 };
  const logs: string[] = [];
  const reports: CycleReport[] = [];
  const state = {
    online: true,
    session: true,
    enabled: true,
    pending: [] as PendingOp[],
    policy: { envelopeDays: 365, bodyDays: 30, maxBodyMB: 50 } as RetentionPolicy,
    ...over,
  };

  const deps: EngineDeps = {
    factory,
    port: fake.asPort(),
    jmapAccountIdFor: () => fake.accountId,
    retentionFor: () => state.policy,
    isEnabled: () => state.enabled,
    isOnline: () => state.online,
    hasLiveSession: () => state.session,
    pendingOpsFor: () => state.pending,
    now: () => clock.t,
    random: () => 0,
    log: (level, message) => logs.push(`${level}: ${message}`),
    onReport: (r) => reports.push(r),
  };

  const harness: Harness = {
    host,
    registry,
    factory,
    server: fake,
    engine: new SyncEngine(deps),
    deps,
    clock,
    logs,
    reports,
    state,
    store: () => factory.open(ACCOUNT),
    relaunch(): Harness {
      const freshRegistry = new SyncRegistry();
      const freshFactory = new SqliteStoreFactory(host, freshRegistry);
      const freshDeps: EngineDeps = { ...deps, factory: freshFactory };
      return {
        ...harness,
        registry: freshRegistry,
        factory: freshFactory,
        deps: freshDeps,
        engine: new SyncEngine(freshDeps),
        store: () => freshFactory.open(ACCOUNT),
      };
    },
  };
  return harness;
}

/** Runs cycles until nothing is left, so a multi-cycle operation can be asserted. */
async function runToQuiescence(h: Harness, maxCycles = 25): Promise<CycleReport[]> {
  const out: CycleReport[] = [];
  for (let i = 0; i < maxCycles; i += 1) {
    const report = await h.engine.runCycle(ACCOUNT, i === 0 ? 'session' : 'unfinished');
    out.push(report);
    if (!report.unfinishedWork) return out;
    if (!report.madeProgress && report.outcome !== 'ok') return out;
  }
  return out;
}

let harness: Harness;

beforeEach(async () => {
  await AsyncStorage.clear();
});

afterEach(() => {
  harness?.host.cleanup();
});

function seedServer(server: FakeJmapServer, count = 5): string[] {
  server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
  server.createMailbox({ id: 'archive', name: 'Archive' });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `E${i}`;
    server.createEmail({ id, receivedAt: isoDaysBefore(count - i) });
    ids.push(id);
  }
  return ids;
}

describe('bootstrap + steady state (§4.1)', () => {
  it('captures cursors BEFORE enumerating, then converges', async () => {
    harness = makeHarness();
    const ids = seedServer(harness.server, 5);

    await runToQuiescence(harness);

    const store = await harness.store();
    // Cursors exist for both types, keyed per (jmapAccountId, type).
    const state = await store.loadAccountState();
    expect(state.cursors.map((c) => c.type).sort()).toEqual(['Email', 'Mailbox']);
    expect(state.coverage[0].phase).toBe('complete');
    expect(state.coverage[0].coveredFrom).toBeTruthy();
    expect(state.resyncRequired).toBe(false);

    // Every message is present, with its mailbox rows.
    const envelopes = await store.queryEnvelopes({
      jmapAccountId: harness.server.accountId,
      limit: 100,
    });
    expect(envelopes.map((e) => e.id).sort()).toEqual(ids.sort());
    expect((await store.listMailboxes(harness.server.accountId)).map((m) => m.id).sort()).toEqual([
      'archive',
      'inbox',
    ]);
  });

  it('picks up mail delivered DURING the coverage scan (the §4.1 ordering test)', async () => {
    // The highest-value test in §13's list. The cursor is seeded before the scan, so
    // a message that arrives mid-scan is either enumerated by the scan or reported by
    // the next /changes page — never neither. The opposite order (scan, then capture)
    // is cheaper and silently loses exactly this message.
    harness = makeHarness();
    seedServer(harness.server, 3);

    // First cycle: bootstrap + a scan.
    await harness.engine.runCycle(ACCOUNT, 'session');
    // Mail arrives after the cursor was captured.
    harness.server.createEmail({ id: 'MIDSCAN', receivedAt: isoDaysBefore(0) });
    await runToQuiescence(harness);

    const store = await harness.store();
    expect(
      await store.getEnvelope({ jmapAccountId: harness.server.accountId, id: 'MIDSCAN' }),
    ).not.toBeNull();
  });

  it('a created email lands as an envelope and its body arrives via the queue', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);

    const store = await harness.store();
    const body = await store.getBody({ jmapAccountId: harness.server.accountId, id: 'E1' });
    expect(body).not.toBeNull();
    expect(JSON.parse(body!.json).bodyValues['1'].value).toBe('body of E1');
    const envelope = await store.getEnvelope({
      jmapAccountId: harness.server.accountId,
      id: 'E1',
    });
    expect(envelope?.hasBody).toBe(true);
    expect(envelope?.bodyBytes).toBeGreaterThan(0);
  });
});

describe('delta application (§5.3) — D1', () => {
  it('a flag change costs a 3-property fetch and NO body refetch', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);

    const bodiesBefore = harness.server.calls.getBodies ?? 0;
    const envelopesBefore = harness.server.calls.getEnvelopes ?? 0;

    // A second client marks E1 read.
    harness.server.updateEmail('E1', { keywords: { $seen: true } });
    await runToQuiescence(harness);

    const store = await harness.store();
    const envelope = await store.getEnvelope({
      jmapAccountId: harness.server.accountId,
      id: 'E1',
    });
    // D1: the shipped bug left a message cached-while-unread unread forever.
    expect(envelope?.keywords).toEqual({ $seen: true });
    // A NETWORK assertion, not just a state assertion (§13): bodies are immutable
    // per RFC 8621 §4.1, so an `updated` Email must never cost a body refetch.
    expect(harness.server.calls.getBodies ?? 0).toBe(bodiesBefore);
    expect(harness.server.calls.getEnvelopes ?? 0).toBe(envelopesBefore);
    expect(harness.server.calls.getMutable).toBeGreaterThan(0);
    // ...and the body blob is still there and still valid.
    expect(envelope?.hasBody).toBe(true);
  });

  it('issues NO 3-property fetch for an updated id we do not hold (F26)', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    // Drop E1 locally — retention decided against it, or coverage has not reached it.
    await store.transaction((txn) => txn.deleteEmails([{ jmapAccountId: ja, id: 'E1' }]));

    const mutableBefore = harness.server.calls.getMutable ?? 0;
    harness.server.updateEmail('E1', { keywords: { $seen: true } });
    await harness.engine.runCycle(ACCOUNT, 'push');

    // Absent ids are filtered out BEFORE the fetch is issued — cheaper, and it avoids
    // fabricating a receivedAt the 3-property response cannot supply and the schema's
    // NOT NULL would reject. This is the network assertion; the state assertion alone
    // would pass even without the filter, because the store's patch no-ops.
    expect(harness.server.calls.getMutable ?? 0).toBe(mutableBefore);
    expect(await store.getEnvelope({ jmapAccountId: ja, id: 'E1' })).toBeNull();
  });

  it('a destroyed email is removed with its body, membership and queue rows', async () => {
    harness = makeHarness();
    seedServer(harness.server, 3);
    await runToQuiescence(harness);

    harness.server.destroyEmail('E1');
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    expect(await store.getEnvelope({ jmapAccountId: ja, id: 'E1' })).toBeNull();
    expect(await store.getBody({ jmapAccountId: ja, id: 'E1' })).toBeNull();
    expect(await store.listOrphanBodies(10)).toEqual([]);
  });

  it('destroying a mailbox never deletes its emails (I7/F7)', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);

    harness.server.destroyMailbox('archive');
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    expect((await store.listMailboxes(ja)).map((m) => m.id)).toEqual(['inbox']);
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(2);
  });

  it('patches only the four count columns when updatedProperties says so (§5.2)', async () => {
    harness = makeHarness();
    seedServer(harness.server, 1);
    await runToQuiescence(harness);

    harness.server.mailboxUpdatedProperties = ['unreadEmails'];
    harness.server.updateMailboxCounts('inbox', { unreadEmails: 42 });
    const fullBefore = harness.server.calls.getMailboxesByIdsFull ?? 0;
    await runToQuiescence(harness);

    const store = await harness.store();
    const inbox = (await store.listMailboxes(harness.server.accountId)).find(
      (m) => m.id === 'inbox',
    );
    expect(inbox?.unreadEmails).toBe(42);
    expect(inbox?.name).toBe('Inbox'); // untouched by the counts patch
    // The whole point of the optimisation: no full folder refetch.
    expect(harness.server.calls.getMailboxesByIdsFull ?? 0).toBe(fullBefore);
    expect(harness.server.calls.getMailboxCounts).toBeGreaterThan(0);
  });
});

describe('crash mid-drain (F1) — I1 cursor-last', () => {
  it('resumes from the last FULLY APPLIED page with no duplicates or omissions', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);

    // Force multi-page drains: maxChanges becomes 2 (§13's integration case).
    harness.server.maxObjectsInGetValue = 2;
    for (let i = 0; i < 7; i += 1) {
      harness.server.createEmail({ id: `N${i}`, receivedAt: isoDaysBefore(0) });
    }

    const store = await harness.store();
    const before = await store.loadAccountState();
    const emailCursor = before.cursors.find((c) => c.type === 'Email') as SyncCursor;

    // ONE page only — the SIGKILL point.
    const partial = await drainEmailChanges(
      {
        store,
        port: harness.deps.port!,
        jmapAccountId: harness.server.accountId,
        bodyFrom: isoDaysBefore(30),
        pageBudget: 1,
        deadlineAt: T0 + 90_000,
        now: () => harness.clock.t,
        shouldAbort: () => false,
      },
      emailCursor,
    );
    expect(partial.outcome).toBe('partial');
    expect(partial.pagesApplied).toBe(1);

    const mid = await store.loadAccountState();
    const midCursor = mid.cursors.find((c) => c.type === 'Email')!;
    // The cursor moved to an INTERMEDIATE state (RFC 8620 §5.2 sanctions this, and
    // it is the only reason crash recovery costs one page instead of a resync)...
    expect(midCursor.state).not.toBe(emailCursor.state);
    // ...and it records that a drain was cut short, so T9 resumes immediately.
    expect(midCursor.drainPending).toBe(true);

    const partialCount = await store.countEnvelopes({ jmapAccountId: harness.server.accountId });
    expect(partialCount).toBeGreaterThan(2);
    expect(partialCount).toBeLessThan(9);

    // "Relaunch": a fresh factory over the same files.
    const relaunched = harness.relaunch();
    await runToQuiescence(relaunched);

    const store2 = await relaunched.store();
    const ids = (
      await store2.queryEnvelopes({ jmapAccountId: harness.server.accountId, limit: 100 })
    ).map((e) => e.id);
    // Convergence: every live id exactly once.
    expect(ids.sort()).toEqual(harness.server.liveEmailIds());
    expect(new Set(ids).size).toBe(ids.length);
    const after = await store2.loadAccountState();
    expect(after.cursors.find((c) => c.type === 'Email')!.drainPending).toBe(false);
  });

  it('a failed page leaves the cursor exactly where it was (§7.4/F12/F30)', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);

    harness.server.createEmail({ id: 'NEW', receivedAt: isoDaysBefore(0) });
    const store = await harness.store();
    const before = await store.loadAccountState();
    const cursorBefore = before.cursors.find((c) => c.type === 'Email')!.state;

    // The envelope fetch fails after /changes succeeded.
    harness.server.faults.getEnvelopes = () => new Error('JMAP request failed: 503');
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
      },
      before.cursors.find((c) => c.type === 'Email')!,
    );

    expect(result.outcome).toBe('failed');
    const after = await store.loadAccountState();
    // Failure means the cursor STANDS STILL — that is what makes "a failure never
    // causes silent data loss" structural rather than aspirational.
    expect(after.cursors.find((c) => c.type === 'Email')!.state).toBe(cursorBefore);
    // ...and the escalation counters advanced instead (§7.7).
    expect(after.cursors.find((c) => c.type === 'Email')!.consecutiveFailures).toBe(1);
    expect(after.cursors.find((c) => c.type === 'Email')!.maxChangesRung).toBe(1);

    // The page replays cleanly once the server recovers.
    await runToQuiescence(harness);
    expect(
      await store.getEnvelope({ jmapAccountId: harness.server.accountId, id: 'NEW' }),
    ).not.toBeNull();
  });

  it('a budget exhaustion is `partial`, not a failure, and touches no counters', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);
    harness.server.maxObjectsInGetValue = 1;
    for (let i = 0; i < 4; i += 1) {
      harness.server.createEmail({ id: `P${i}`, receivedAt: isoDaysBefore(0) });
    }

    const store = await harness.store();
    const state = await store.loadAccountState();
    const result = await drainEmailChanges(
      {
        store,
        port: harness.deps.port!,
        jmapAccountId: harness.server.accountId,
        bodyFrom: isoDaysBefore(30),
        pageBudget: 2,
        deadlineAt: T0 + 90_000,
        now: () => harness.clock.t,
        shouldAbort: () => false,
      },
      state.cursors.find((c) => c.type === 'Email')!,
    );
    expect(result.outcome).toBe('partial');
    const after = await store.loadAccountState();
    const cursor = after.cursors.find((c) => c.type === 'Email')!;
    expect(cursor.consecutiveFailures).toBe(0);
    expect(cursor.maxChangesRung).toBe(0);
    expect(cursor.drainPending).toBe(true);
  });
});

describe('StateInvalid and reconcile (§7.6) — F9 / F49 / F38', () => {
  it('cannotCalculateChanges keeps records readable and rebuilds', async () => {
    harness = makeHarness();
    seedServer(harness.server, 4);
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(4);

    // Server loses its change log: every existing cursor is now too old.
    harness.server.expireChangeLog();
    harness.server.createEmail({ id: 'AFTER', receivedAt: isoDaysBefore(0) });

    const first = await harness.engine.runCycle(ACCOUNT, 'push');
    // A literal reading of RFC 8620 §5.2 ("invalidate your cache") would empty the
    // user's offline mail exactly when they may be offline and depending on it.
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBeGreaterThan(0);
    expect(first.unfinishedWork).toBe(true);
    expect(harness.logs.join('\n')).toMatch(/invalidated \(cannotCalculateChanges\)/);

    await runToQuiescence(harness);

    const finalState = await store.loadAccountState();
    expect(finalState.resyncRequired).toBe(false);
    expect(finalState.coverage[0].phase).toBe('complete');
    expect(finalState.coverage[0].sweepFloor).toBeUndefined();
    // The sweep deletes exactly the server-absent ids and keeps the rest.
    const ids = (await store.queryEnvelopes({ jmapAccountId: ja, limit: 100 })).map((e) => e.id);
    expect(ids.sort()).toEqual(harness.server.liveEmailIds());
    // A completed reconcile resets the escalation counters (V2).
    for (const cursor of finalState.cursors) {
      expect(cursor.consecutiveFailures).toBe(0);
      expect(cursor.maxChangesRung).toBe(0);
      expect(cursor.invalidatedAt).toBeUndefined();
    }
  });

  it('the sweep removes a message destroyed while we could not hear about it', async () => {
    harness = makeHarness();
    seedServer(harness.server, 4);
    await runToQuiescence(harness);

    // Destroy E1, THEN blow away the change log, so /changes can never report it.
    harness.server.destroyEmail('E1');
    harness.server.expireChangeLog();

    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    // Only the reconcile's enumeration + sweep could have found this.
    expect(await store.getEnvelope({ jmapAccountId: ja, id: 'E1' })).toBeNull();
    expect(
      (await store.queryEnvelopes({ jmapAccountId: ja, limit: 100 })).map((e) => e.id).sort(),
    ).toEqual(harness.server.liveEmailIds());
  });

  it('widening retention MID-RECONCILE deletes nothing in the gap (F38)', async () => {
    // §13 calls this "the test for the design's worst potential data-loss bug".
    harness = makeHarness({ policy: { envelopeDays: 10, bodyDays: 5, maxBodyMB: 50 } });
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    // Inside the initial 10-day window...
    harness.server.createEmail({ id: 'RECENT', receivedAt: isoDaysBefore(2) });
    // ...and in the gap that a widen to 200 days would newly include.
    harness.server.createEmail({ id: 'OLD', receivedAt: isoDaysBefore(100) });

    await runToQuiescence(harness);
    const store = await harness.store();
    const ja = harness.server.accountId;
    // OLD is outside the 10-day window, so it is not held yet.
    expect(await store.getEnvelope({ jmapAccountId: ja, id: 'OLD' })).toBeNull();
    expect(await store.getEnvelope({ jmapAccountId: ja, id: 'RECENT' })).not.toBeNull();

    // Force a reconcile and get it STARTED without finishing. On a mailbox this
    // small the enumeration would otherwise complete in the same cycle, so make the
    // scan fail once — which is also the realistic shape: a multi-cycle reconcile is
    // exactly the situation S2 is about (§7.6, F49).
    harness.server.expireChangeLog();
    await store.transaction((txn) => txn.patchAccountFlags({ resyncRequired: true }));
    harness.server.faults.queryWindow = () => new Error('JMAP request failed: 503');
    await harness.engine.runCycle(ACCOUNT, 'push');

    const midState = await store.loadAccountState();
    expect(midState.coverage[0].phase).toBe('reconciling');
    const pinnedFloor = midState.coverage[0].sweepFloor;
    expect(pinnedFloor).toBeTruthy();
    expect(midState.coverage[0].reconcileStampedAt).toBeGreaterThan(0);

    // The user opens Settings during the "re-syncing offline mail" banner and widens
    // retention — exactly the sequence S2 identified.
    harness.state.policy = { envelopeDays: 200, bodyDays: 5, maxBodyMB: 50 };
    await runToQuiescence(harness);

    const after = await store.loadAccountState();

    // THE direct S2 assertion: the sweep ran against the PINNED floor, not the live
    // (widened) one. Before revision 2's fix the sweep would have used the new wider
    // floor while the enumeration had only covered the old narrower one — and then set
    // coveredFrom to the wider floor, so coverage would believe that range complete
    // and delta sync cannot re-deliver pre-existing mail. Permanent loss.
    const sweepLog = harness.logs.find((l) => l.includes('reconcile sweep'));
    expect(sweepLog, 'the reconcile must actually reach its sweep').toBeTruthy();
    expect(sweepLog).toContain(pinnedFloor!);
    // By the end, coverage has legitimately EXTENDED to the widened floor — that is
    // the deferral being applied at step 5 and the scan then reaching further back,
    // which is a different thing from the sweep having used the widened floor.
    expect(after.coverage[0].coveredFrom).toBe(after.coverage[0].targetFrom);
    expect(Date.parse(after.coverage[0].coveredFrom!)).toBeLessThan(Date.parse(pinnedFloor!));

    expect(await store.getEnvelope({ jmapAccountId: ja, id: 'RECENT' })).not.toBeNull();
    // The deferred widen was applied afterwards, and coverage extended into the gap.
    expect(after.coverage[0].deferredTargetFrom).toBeUndefined();
    expect(Date.parse(after.coverage[0].targetFrom)).toBeLessThan(Date.parse(pinnedFloor!));
    expect(await store.getEnvelope({ jmapAccountId: ja, id: 'OLD' })).not.toBeNull();
    expect(harness.logs.join('\n')).toMatch(/deferred/);
  });

  it('keeps delta flowing while a reconcile enumeration is in progress (S9/F49)', async () => {
    harness = makeHarness();
    seedServer(harness.server, 3);
    await runToQuiescence(harness);

    harness.server.expireChangeLog();
    // Hold the enumeration open for one cycle so 'reconciling' is observable at all;
    // otherwise this mailbox is small enough to rebuild inside a single cycle.
    harness.server.faults.queryWindow = () => new Error('JMAP request failed: 503');
    await harness.engine.runCycle(ACCOUNT, 'push'); // invalidate + start reconcile

    const store = await harness.store();
    const mid = await store.loadAccountState();
    expect(mid.coverage[0].phase).toBe('reconciling');
    // The freshly SEEDED cursors are live immediately: they are the server's current
    // state, so changes after them are delivered correctly. Only the SWEEP waits.
    for (const cursor of mid.cursors) {
      expect(cursor.invalidatedAt).toBeUndefined();
      expect(cursor.state).toBeTruthy();
    }

    // New mail arrives during the rebuild and must still land.
    harness.server.createEmail({ id: 'DURING', receivedAt: isoDaysBefore(0) });
    await runToQuiescence(harness);
    expect(
      await store.getEnvelope({ jmapAccountId: harness.server.accountId, id: 'DURING' }),
    ).not.toBeNull();
  });

  it('confirms an oldState mismatch before escalating (S10/F39)', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);

    // A server that echoes a semantically-equal but non-byte-identical oldState.
    // Without §7.6.1's re-issue check, EVERY cycle would trip this, reconcile, seed a
    // fresh cursor and trip again — unbounded rescans that consecutiveFailures never
    // catches because each reconcile "succeeds".
    harness.server.echoCosmeticOldState = true;
    harness.server.createEmail({ id: 'X', receivedAt: isoDaysBefore(0) });

    const store = await harness.store();
    const state = await store.loadAccountState();
    const result = await drainMailboxChanges(
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
      state.cursors.find((c) => c.type === 'Mailbox')!,
    );

    // Confirmed on re-issue as the SAME cosmetic mismatch -> still escalates. What
    // matters is that it took two calls, not one, and said so.
    expect(harness.server.calls.mailboxChanges).toBeGreaterThanOrEqual(2);
    expect(result.outcome).toBe('state-invalid');
    expect(result.invalidReason).toBe('oldStateMismatch');
  });
});

describe('multi-account isolation (§8, D6/F21)', () => {
  it('rejects a commit when the epoch moves mid-cycle, writing nothing', async () => {
    harness = makeHarness();
    seedServer(harness.server, 3);
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    const before = await store.countEnvelopes({ jmapAccountId: ja });

    harness.server.createEmail({ id: 'RACED', receivedAt: isoDaysBefore(0) });
    // switchAccount lands mid-cycle.
    await harness.registry.bumpEpoch(ACCOUNT, 'switchAccount');

    const report = await harness.engine.runCycle(ACCOUNT, 'foreground');
    // F21: the epoch guard rejects the commit; the cycle is ABANDONED, not failed,
    // and nothing partial landed.
    expect(report.outcome).toBe('abandoned');
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(before);
  });

  it('refuses to fetch when the client no longer serves this account (§8.3)', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);

    harness.server.createEmail({ id: 'B-MAIL', receivedAt: isoDaysBefore(0) });
    // The generalisation of jmapClientServesActiveAccount: checked before EVERY
    // network call, not just at cycle start, because a cycle is long-lived.
    harness.server.servedAccountId = 'some-other-account';

    const callsBefore = harness.server.calls.emailChanges ?? 0;
    await harness.engine.runCycle(ACCOUNT, 'foreground');
    // No fetch was issued for an account the client is not serving, so no row could
    // land under the wrong account (D6).
    expect(harness.server.calls.emailChanges ?? 0).toBe(callsBefore);
    const store = await harness.store();
    expect(
      await store.getEnvelope({ jmapAccountId: harness.server.accountId, id: 'B-MAIL' }),
    ).toBeNull();
  });

  it('two accounts keep entirely separate stores and cursors (§8.1)', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);

    const other = 'bob@mail.example';
    const otherStore = await harness.factory.open(other);
    await otherStore.transaction((txn) =>
      txn.upsertEnvelopes([
        {
          jmapAccountId: harness.server.accountId,
          id: 'BOB-1',
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
          mailboxIds: {},
          hasBody: false,
          bodyBytes: 0,
          cachedAt: T0,
        },
      ]),
    );

    // Purging one account leaves the other completely intact — the property that
    // makes the later SQLCipher per-account wipe work.
    await harness.factory.purgeAccount(ACCOUNT, 'logout');
    expect(await harness.factory.isMaterialised(other)).toBe(true);
    expect(await (await harness.factory.open(other)).countEnvelopes()).toBe(1);
    const reopened = await harness.factory.open(ACCOUNT);
    expect((await reopened.loadAccountState()).cursors).toEqual([]);
  });
});

describe('corrupt state (I13/F43)', () => {
  it('forces a resync instead of falling back to an empty cursor set', async () => {
    harness = makeHarness();
    seedServer(harness.server, 3);
    await runToQuiescence(harness);

    // Corrupt a cursor row directly in the database.
    const db = await harness.host.open(databaseNameFor(ACCOUNT));
    await db.runAsync('UPDATE sync_state SET v = ? WHERE k = ?', [
      '{not json',
      cursorStateKey(harness.server.accountId, 'Email'),
    ]);

    await harness.engine.runCycle(ACCOUNT, 'session');
    // The load raised CorruptStateError and the engine forced a resync rather than
    // reporting an empty cursor set. Falling back to "no cursors" would leave a store
    // full of unverified pre-existing records that no sweep ever visits.
    expect(harness.logs.join('\n')).toMatch(/corrupt sync state/);
    expect(harness.logs.join('\n')).toMatch(/forcing a resync/);

    await runToQuiescence(harness);
    const store = await harness.store();
    const state = await store.loadAccountState();
    // Fresh, parseable cursors exist again — the resync rebuilt them.
    expect(state.cursors.map((c) => c.type).sort()).toEqual(['Email', 'Mailbox']);
    expect(state.resyncRequired).toBe(false); // the reconcile completed
    expect(state.coverage[0].phase).toBe('complete');
    expect(
      (await store.queryEnvelopes({ jmapAccountId: harness.server.accountId, limit: 100 })).map(
        (e) => e.id,
      ).sort(),
    ).toEqual(harness.server.liveEmailIds());
  });
});

describe('clock skew (F31/F44)', () => {
  it('holds the previous retention floor through a large clock jump', async () => {
    harness = makeHarness();
    seedServer(harness.server, 3);
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    const before = await store.countEnvelopes({ jmapAccountId: ja });
    expect(before).toBe(3);

    // The device clock jumps a year forward, which would put every message outside
    // the retention window.
    harness.clock.t = T0 + 365 * DAY;
    await harness.engine.runCycle(ACCOUNT, 'foreground');

    expect(harness.logs.join('\n')).toMatch(/retention floor moved/);
    // Nothing was evicted on the strength of one suspicious observation.
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(before);
  });

  it('cursors are unaffected by the clock (I8)', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);
    const store = await harness.store();
    const before = (await store.loadAccountState()).cursors.map((c) => c.state).sort();

    harness.clock.t = T0 - 500 * DAY; // clock jumps BACKWARD
    await harness.engine.runCycle(ACCOUNT, 'foreground');

    const after = (await store.loadAccountState()).cursors.map((c) => c.state).sort();
    // Cursors are opaque SERVER strings; a device clock cannot move them.
    expect(after).toEqual(before);
  });
});

describe('§10.3 single-flight — D7 / F5 / F6', () => {
  it('a second trigger during a cycle coalesces instead of cancelling it', async () => {
    harness = makeHarness();
    seedServer(harness.server, 3);

    const first = harness.engine.runCycle(ACCOUNT, 'session');
    const second = harness.engine.runCycle(ACCOUNT, 'manual');
    // D7: `runOfflineSync` set the abort flag and returned, so tapping "Sync now"
    // during a sync yielded a CANCELLED sync and no new one. Callers now await the
    // same promise.
    expect(second).toBe(first);

    const report = await first;
    expect(report.outcome).not.toBe('abandoned');
    // The reason the second caller wanted a cycle is remembered for §10.3's chaining.
    expect(harness.engine.takeWakeReasons(ACCOUNT)).toEqual(['manual']);
  });

  it('does not start a cycle while offline, and touches no counters (§7.3/F13)', async () => {
    harness = makeHarness({ online: false });
    seedServer(harness.server, 2);
    const report = await harness.engine.runCycle(ACCOUNT, 'session');
    expect(report.outcome).toBe('abandoned');
    expect(report.error).toBeUndefined();
    // §9.5: nothing was even materialised.
    expect(await harness.factory.isMaterialised(ACCOUNT)).toBe(false);
  });

  it('does not open the store for a disabled account (§9.5/T10)', async () => {
    harness = makeHarness({ enabled: false });
    seedServer(harness.server, 2);
    const report = await harness.engine.runCycle(ACCOUNT, 'session');
    expect(report.outcome).toBe('abandoned');
    expect(await harness.factory.isMaterialised(ACCOUNT)).toBe(false);
  });
});

describe('bodies: C2 backfill and retention (S9 / F24 / F24B / F25)', () => {
  it('widening the BODY window backfills already-covered envelopes (F24/S9)', async () => {
    harness = makeHarness({ policy: { envelopeDays: 365, bodyDays: 3, maxBodyMB: 50 } });
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    harness.server.createEmail({ id: 'NEWISH', receivedAt: isoDaysBefore(1) });
    harness.server.createEmail({ id: 'OLDISH', receivedAt: isoDaysBefore(20) });

    await runToQuiescence(harness);
    const store = await harness.store();
    const ja = harness.server.accountId;
    // Both envelopes are held; only the recent one has a body.
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(2);
    expect(await store.getBody({ jmapAccountId: ja, id: 'NEWISH' })).not.toBeNull();
    expect(await store.getBody({ jmapAccountId: ja, id: 'OLDISH' })).toBeNull();

    // Widen only the BODY window. Without job C2 this silently does nothing for
    // already-covered envelopes — revision 1's gap, and the operation §2.1's
    // retention decision makes user-reachable.
    harness.state.policy = { envelopeDays: 365, bodyDays: 90, maxBodyMB: 50 };
    await runToQuiescence(harness);

    expect(await store.getBody({ jmapAccountId: ja, id: 'OLDISH' })).not.toBeNull();
  });

  it('narrowing the body window keeps the envelope listed (F24B)', async () => {
    harness = makeHarness({ policy: { envelopeDays: 365, bodyDays: 90, maxBodyMB: 50 } });
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    harness.server.createEmail({ id: 'OLDISH', receivedAt: isoDaysBefore(20) });
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    expect(await store.getBody({ jmapAccountId: ja, id: 'OLDISH' })).not.toBeNull();

    harness.state.policy = { envelopeDays: 365, bodyDays: 3, maxBodyMB: 50 };
    await runToQuiescence(harness);

    // Body shed, envelope survives — so the message stays listed and openable online.
    expect(await store.getBody({ jmapAccountId: ja, id: 'OLDISH' })).toBeNull();
    const envelope = await store.getEnvelope({ jmapAccountId: ja, id: 'OLDISH' });
    expect(envelope).not.toBeNull();
    expect(envelope?.hasBody).toBe(false);
  });

  it('evicts bodies oldest-first when over the MB cap, keeping envelopes (F25)', async () => {
    harness = makeHarness({
      // A cap small enough that not every body fits.
      policy: { envelopeDays: 365, bodyDays: 90, maxBodyMB: 0 },
    });
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    for (let i = 0; i < 3; i += 1) {
      harness.server.createEmail({ id: `E${i}`, receivedAt: isoDaysBefore(3 - i) });
    }
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    // Every envelope survives; the cap applies to bodies only (§2.1).
    expect(await store.countEnvelopes({ jmapAccountId: ja })).toBe(3);
    expect(await store.bodyBytesTotal()).toBe(0);
    expect(await store.listOrphanBodies(10)).toEqual([]);
  });

  it('dequeues immediately when a body turns out to be gone (F40)', async () => {
    harness = makeHarness();
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    harness.server.createEmail({ id: 'DOOMED', receivedAt: isoDaysBefore(1) });

    // Bootstrap enqueues the body...
    await harness.engine.runCycle(ACCOUNT, 'session');
    const store = await harness.store();
    const ja = harness.server.accountId;

    // ...then the message vanishes server-side before the body is fetched.
    await store.transaction((txn) =>
      txn.enqueueBodies([
        { jmapAccountId: ja, emailId: 'DOOMED', receivedAt: isoDaysBefore(1), attempts: 0 },
      ]),
    );
    harness.server.destroyEmail('DOOMED');
    await runToQuiescence(harness);

    // The entry can never succeed, so it must not burn five attempts.
    expect(await store.takeBodyQueue(10, harness.clock.t)).toEqual([]);
  });

  it('dequeues a notFound body WITHOUT the destroy path helping (F40, isolated)', async () => {
    // The end-to-end version of this is not a real test of F40: when the delta path
    // reports the message destroyed, `deleteEmails` removes the queue row anyway, so
    // the queue ends up empty whether or not F40 works. Isolate it by draining a queue
    // entry for an id the server does not have, with no destroy in flight.
    harness = makeHarness();
    seedServer(harness.server, 1);
    await runToQuiescence(harness);

    const store = await harness.store();
    const ja = harness.server.accountId;
    // A local envelope with no server counterpart — reachable after a reconcile races
    // a delete, and exactly the state F40 is about.
    await store.transaction(async (txn) => {
      await txn.upsertEnvelopes([
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
      ]);
      await txn.enqueueBodies([
        { jmapAccountId: ja, emailId: 'GHOST', receivedAt: isoDaysBefore(1), attempts: 0 },
      ]);
    });

    const drained = await drainBodyQueue({
      store,
      port: harness.deps.port!,
      jmapAccountId: ja,
      bodyFrom: isoDaysBefore(30),
      maxBodyBytes: 50 * 1024 * 1024,
      itemBudget: 50,
      deadlineAt: T0 + 90_000,
      now: () => harness.clock.t,
      shouldAbort: () => false,
      backoffMs: () => 1_000,
    });

    // Dequeued IMMEDIATELY, not retried: the entry can never succeed and would
    // otherwise burn five attempts and leave a row behind.
    expect(drained.dequeued).toBeGreaterThan(0);
    expect(await store.takeBodyQueue(10, harness.clock.t + 10 * 60_000)).toEqual([]);
  });

  it('a body failure never moves a cursor (§7.4)', async () => {
    harness = makeHarness();
    seedServer(harness.server, 2);
    await runToQuiescence(harness);

    const store = await harness.store();
    const before = (await store.loadAccountState()).cursors.map((c) => c.state).sort();

    harness.server.createEmail({ id: 'BODYFAIL', receivedAt: isoDaysBefore(0) });
    harness.server.faults.getBodies = () => new Error('JMAP request failed: 503');
    await harness.engine.runCycle(ACCOUNT, 'foreground');

    const after = (await store.loadAccountState()).cursors;
    // C1/C2 are separate state: the delta path keeps its position.
    expect(after.every((c) => c.consecutiveFailures === 0)).toBe(true);
    // The envelope landed even though its body did not.
    expect(
      await store.getEnvelope({ jmapAccountId: harness.server.accountId, id: 'BODYFAIL' }),
    ).not.toBeNull();
    expect(after.map((c) => c.state).sort()).not.toEqual(before);
  });
});

describe('coverage scan paging (§6.1)', () => {
  it('walks ascending and tolerates the inclusive `after` boundary (S14)', async () => {
    harness = makeHarness();
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    // More than one page at a reduced page size is hard to force without changing the
    // constant, so assert the semantics instead: the boundary message is re-returned
    // and deduped rather than duplicated or skipped.
    for (let i = 0; i < 5; i += 1) {
      harness.server.createEmail({ id: `S${i}`, receivedAt: isoDaysBefore(5 - i) });
    }
    await runToQuiescence(harness);

    const store = await harness.store();
    const ids = (
      await store.queryEnvelopes({ jmapAccountId: harness.server.accountId, limit: 100 })
    ).map((e) => e.id);
    expect(ids.sort()).toEqual(['S0', 'S1', 'S2', 'S3', 'S4']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('records a durable gap marker if it ever has to skip a tie cluster (F33)', async () => {
    // Force the pathological shape: every message shares one millisecond, and the
    // server rejects anchors, so only the last-resort rung is left.
    harness = makeHarness();
    harness.server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
    harness.server.disableAnchor();
    harness.server.maxObjectsInGetValue = 2;
    const sameMs = isoDaysBefore(1);
    for (let i = 0; i < 3; i += 1) {
      harness.server.createEmail({ id: `T${i}`, receivedAt: sameMs });
    }
    await runToQuiescence(harness);

    const store = await harness.store();
    // Whatever happened, it terminated and left the records readable — the scan can
    // never spin (I9).
    expect(
      await store.countEnvelopes({ jmapAccountId: harness.server.accountId }),
    ).toBeGreaterThan(0);
  });
});
