// Stage D steps 3, 5 and 6: the WIRING, not the engine.
//
// The engine has strong isolated coverage already. What was untested is whether a real
// trigger actually reaches it and whether the result actually reaches the read path the UI
// uses — so these drive the real `TriggerCoordinator`, the real `SyncEngine`, the real
// SQLite store and the real `offline-reads` layer, with only the network and the clock
// faked.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncEngine, type CycleReport, type EngineDeps } from '../engine';
import { readMailboxPage, readMessage } from '../offline-reads';
import type { PendingOp } from '../overlay';
import { SyncRegistry } from '../registry';
import { SqliteStoreFactory } from '../store-sqlite';
import { TriggerCoordinator, type TriggerDeps } from '../triggers';
import { useSyncStatusStore } from '../../stores/sync-status-store';
import { FakeJmapServer } from './fake-jmap';
import { createTestHost } from './sqlite-test-driver';

const ACCOUNT = 'alice@mail.example';
const T0 = Date.parse('2026-08-04T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function isoDaysBefore(days: number): string {
  return new Date(T0 - days * DAY).toISOString();
}

interface Wiring {
  host: ReturnType<typeof createTestHost>;
  factory: SqliteStoreFactory;
  server: FakeJmapServer;
  engine: SyncEngine;
  coordinator: TriggerCoordinator;
  clock: { t: number };
  timers: Array<{ at: number; fn: () => void }>;
  reports: CycleReport[];
  phases: string[];
  pending: PendingOp[];
  enabled: { value: boolean };
  /** Runs due timers and awaits whatever they kicked off. */
  tick(ms: number): Promise<void>;
}

function build(): Wiring {
  const host = createTestHost();
  const registry = new SyncRegistry();
  const factory = new SqliteStoreFactory(host, registry);
  const server = new FakeJmapServer();
  const clock = { t: T0 };
  const timers: Array<{ at: number; fn: () => void }> = [];
  const reports: CycleReport[] = [];
  const phases: string[] = [];
  const pending: PendingOp[] = [];
  const enabled = { value: true };
  let coordinator: TriggerCoordinator;

  const engineDeps: EngineDeps = {
    factory,
    port: server.asPort(),
    jmapAccountIdFor: (id) => (id === ACCOUNT ? server.accountId : null),
    retentionFor: () => ({ envelopeDays: 365, bodyDays: 30, maxBodyMB: 50 }),
    isEnabled: () => enabled.value,
    isOnline: () => true,
    hasLiveSession: () => true,
    pendingOpsFor: () => pending,
    now: () => clock.t,
    random: () => 0,
    sleep: async () => undefined,
    onPhase: (_a, phase) => {
      phases.push(phase);
      useSyncStatusStore.getState().notePhase(phase);
    },
    onReport: (report) => {
      reports.push(report);
      useSyncStatusStore.getState().noteReport(report);
      // Exactly what app-wiring does: hand the report to the coordinator so §10.3's
      // chaining runs.
      coordinator.onCycleFinished(report);
    },
  };
  const engine = new SyncEngine(engineDeps);

  const triggerDeps: TriggerDeps = {
    engine,
    activeAccounts: () => [ACCOUNT],
    jmapAccountIdFor: (id) => (id === ACCOUNT ? server.accountId : null),
    cursorState: () => null,
    now: () => clock.t,
    schedule: (fn, ms) => timers.push({ at: clock.t + ms, fn }),
  };
  coordinator = new TriggerCoordinator(triggerDeps);

  const wiring: Wiring = {
    host,
    factory,
    server,
    engine,
    coordinator,
    clock,
    timers,
    reports,
    phases,
    pending,
    enabled,
    async tick(ms: number): Promise<void> {
      clock.t += ms;
      // Chained triggers schedule more timers, so keep draining until quiet or capped.
      for (let round = 0; round < 40; round += 1) {
        const due = timers.filter((t) => t.at <= clock.t);
        if (due.length === 0) break;
        for (const t of due) timers.splice(timers.indexOf(t), 1);
        for (const t of due) t.fn();
        // Let the cycle (and any chained one) settle.
        for (let i = 0; i < 30; i += 1) await Promise.resolve();
        await new Promise<void>((r) => setImmediate(r));
        clock.t += 5_000; // advance past T9's chaining interval
      }
    },
  };
  return wiring;
}

let w: Wiring;

beforeEach(async () => {
  await AsyncStorage.clear();
  useSyncStatusStore.getState().reset();
  useSyncStatusStore.setState({ phase: 'idle', startedAt: undefined });
});

afterEach(() => {
  w?.host.cleanup();
});

function seed(server: FakeJmapServer, count: number): void {
  server.createMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' });
  for (let i = 0; i < count; i += 1) {
    server.createEmail({ id: `E${i}`, receivedAt: isoDaysBefore(count - i) });
  }
}

describe('a real trigger reaches the engine and the result reaches the read path', () => {
  it('T1 (session) surfaces mail through offline-reads, which is what email-store calls', async () => {
    w = build();
    seed(w.server, 3);

    w.coordinator.fire('session');
    // Nothing yet: §10.1 gives the cold-start trigger a 2 s debounce so it does not
    // compete with the inbox load.
    expect(w.reports).toHaveLength(0);

    await w.tick(2_000);

    expect(w.reports.length).toBeGreaterThan(0);
    // The assertion that matters: the SAME function email-store's cache seed calls.
    const rows = await readMailboxPage(ACCOUNT, w.server.accountId, 'inbox', 50, {
      factory: w.factory,
      pendingOps: () => w.pending,
      engineEnabled: () => true,
      cacheEnabled: () => true,
    });
    expect(rows?.map((e) => e.id).sort()).toEqual(['E0', 'E1', 'E2']);
  });

  it('T5 (push StateChange) picks up mail that arrived after the last cycle', async () => {
    w = build();
    seed(w.server, 1);
    w.coordinator.fire('session');
    await w.tick(2_000);

    w.server.createEmail({ id: 'PUSHED', receivedAt: isoDaysBefore(0) });

    // Exactly the shape App.tsx routes in from `startPushUpdates`.
    w.coordinator.onStateChange({
      changed: { [w.server.accountId]: { Email: 's999' } },
    });
    await w.tick(2_000);

    const rows = await readMailboxPage(ACCOUNT, w.server.accountId, 'inbox', 50, {
      factory: w.factory,
      pendingOps: () => w.pending,
      engineEnabled: () => true,
      cacheEnabled: () => true,
    });
    expect(rows?.map((e) => e.id)).toContain('PUSHED');
  });

  it('a Mailbox change surfaces the new folder through the store', async () => {
    w = build();
    seed(w.server, 1);
    w.coordinator.fire('session');
    await w.tick(2_000);

    w.server.createMailbox({ id: 'projects', name: 'Projects' });
    w.coordinator.onStateChange({
      changed: { [w.server.accountId]: { Mailbox: 's999' } },
    });
    await w.tick(2_000);

    const store = await w.factory.open(ACCOUNT);
    expect((await store.listMailboxes(w.server.accountId)).map((m) => m.id).sort()).toEqual([
      'inbox',
      'projects',
    ]);
  });

  it('a body arrives, so the detail read path can serve it offline', async () => {
    w = build();
    seed(w.server, 1);
    w.coordinator.fire('session');
    await w.tick(2_000);

    const detail = await readMessage(ACCOUNT, w.server.accountId, 'E0', {
      factory: w.factory,
      pendingOps: () => w.pending,
      engineEnabled: () => true,
      cacheEnabled: () => true,
    });
    expect(detail?.id).toBe('E0');
    // The body tier was merged in — this is `getEmailDetail`'s offline fallback.
    expect(detail?.bodyValues?.['1']?.value).toBe('body of E0');
  });

  it('the overlay applies on the wired read path too', async () => {
    w = build();
    seed(w.server, 2);
    w.coordinator.fire('session');
    await w.tick(2_000);

    // The user marks it read while offline; the outbox holds the intent.
    w.pending.push({ kind: 'keywords', emailId: 'E0', keywords: { $seen: true } });

    const detail = await readMessage(ACCOUNT, w.server.accountId, 'E0', {
      factory: w.factory,
      pendingOps: () => w.pending,
      engineEnabled: () => true,
      cacheEnabled: () => true,
    });
    expect(detail?.keywords).toEqual({ $seen: true });

    const rows = await readMailboxPage(ACCOUNT, w.server.accountId, 'inbox', 50, {
      factory: w.factory,
      pendingOps: () => w.pending,
      engineEnabled: () => true,
      cacheEnabled: () => true,
    });
    expect(rows?.find((e) => e.id === 'E0')?.keywords).toEqual({ $seen: true });
  });
});

describe('the flag and the enabled check gate the engine', () => {
  it('offline-reads returns null when the engine flag is off, so v1 keeps its behaviour', async () => {
    w = build();
    seed(w.server, 1);
    w.coordinator.fire('session');
    await w.tick(2_000);

    const rows = await readMailboxPage(ACCOUNT, w.server.accountId, 'inbox', 50, {
      factory: w.factory,
      pendingOps: () => w.pending,
      engineEnabled: () => false,
      cacheEnabled: () => true,
    });
    // `null`, not `[]` — the caller must fall through to the v1 cache rather than render
    // an empty list.
    expect(rows).toBeNull();
  });

  it('returns null when offline caching itself is off', async () => {
    w = build();
    const rows = await readMailboxPage(ACCOUNT, w.server.accountId, 'inbox', 50, {
      factory: w.factory,
      pendingOps: () => w.pending,
      engineEnabled: () => true,
      cacheEnabled: () => false,
    });
    expect(rows).toBeNull();
  });

  it('reads an account that never synced without materialising a store (§9.5)', async () => {
    w = build();
    const rows = await readMailboxPage(ACCOUNT, w.server.accountId, 'inbox', 50, {
      factory: w.factory,
      pendingOps: () => w.pending,
      engineEnabled: () => true,
      cacheEnabled: () => true,
    });
    expect(rows).toEqual([]);
    expect(await w.factory.isMaterialised(ACCOUNT)).toBe(false);
  });

  it('a disabled account does not sync at all (T10 / §9.5)', async () => {
    w = build();
    seed(w.server, 2);
    w.enabled.value = false;

    w.coordinator.fire('session');
    await w.tick(2_000);

    expect(w.reports.every((r) => r.outcome === 'abandoned')).toBe(true);
    expect(await w.factory.isMaterialised(ACCOUNT)).toBe(false);
  });
});

describe('the status store reflects the engine, for the banner (step 5)', () => {
  it('records phases as they happen and settles to done', async () => {
    w = build();
    seed(w.server, 2);

    w.coordinator.fire('session');
    await w.tick(2_000);

    // The engine emits phases as each begins, so a long bootstrap is visible rather than
    // only reported at the end.
    expect(w.phases).toContain('bootstrap');
    expect(w.phases.some((p) => p.startsWith('delta:'))).toBe(true);
    expect(w.phases.some((p) => p.startsWith('bodies:'))).toBe(true);

    const status = useSyncStatusStore.getState();
    expect(status.phase).toBe('done');
    expect(status.unfinished).toBe(false);
  });

  it('reports an error phase with the message, not a silent stall', async () => {
    w = build();
    seed(w.server, 2);
    w.coordinator.fire('session');
    await w.tick(2_000);

    w.server.createEmail({ id: 'X', receivedAt: isoDaysBefore(0) });
    w.server.stickyFaults.emailChanges = () => new Error('JMAP request failed: 500');
    w.coordinator.fire('manual');
    await w.tick(0);

    const status = useSyncStatusStore.getState();
    expect(status.phase).toBe('error');
    expect(status.message).toMatch(/500/);
  });

  it('does not report an error merely because the app is offline (§7.3)', async () => {
    const host = createTestHost();
    const factory = new SqliteStoreFactory(host, new SyncRegistry());
    const server = new FakeJmapServer();
    const reports: CycleReport[] = [];
    const engine = new SyncEngine({
      factory,
      port: server.asPort(),
      jmapAccountIdFor: () => server.accountId,
      retentionFor: () => ({ envelopeDays: 365, bodyDays: 30, maxBodyMB: 50 }),
      isEnabled: () => true,
      isOnline: () => false,
      hasLiveSession: () => true,
      pendingOpsFor: () => [],
      now: () => T0,
      onReport: (r) => {
        reports.push(r);
        useSyncStatusStore.getState().noteReport(r);
      },
    });
    await engine.runCycle(ACCOUNT, 'session');
    expect(reports[0].outcome).toBe('abandoned');
    // The OfflineBanner already tells the user they are offline; a second red bar saying
    // "sync failed" would be noise, and §7.3 is explicit that offline is not an error.
    expect(useSyncStatusStore.getState().phase).toBe('idle');
    host.cleanup();
  });
});

describe('§8.4: turning the feature off purges the store', () => {
  it('removes every account\'s store and leaves it ready to bootstrap', async () => {
    // The user's intent in switching offline mail off is "don't keep my mail on this
    // device", and once the store is encrypted a dormant database plus a live key in
    // expo-secure-store is a liability with no benefit. Re-enabling costs a full
    // bootstrap, which is why the Settings toggle confirms first.
    w = build();
    seed(w.server, 3);
    w.coordinator.fire('session');
    await w.tick(2_000);
    expect(await w.factory.isMaterialised(ACCOUNT)).toBe(true);

    for (const id of await w.factory.listAccounts()) {
      await w.factory.purgeAccount(id, 'feature-disabled');
    }

    expect(await w.factory.isMaterialised(ACCOUNT)).toBe(false);
    const reopened = await w.factory.open(ACCOUNT);
    // A stale cursor surviving a purge would be catastrophic: it would be advanced
    // against a freshly-empty store, skipping changes no /changes page can re-report.
    expect((await reopened.loadAccountState()).cursors).toEqual([]);
    expect(await reopened.countEnvelopes()).toBe(0);
  });
});
