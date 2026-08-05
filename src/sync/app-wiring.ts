// Where the engine meets the app (§10, §14.2).
//
// Everything the engine needs is INJECTED here and nowhere else, which is what keeps
// §10.5's headless constraint true: the engine and the trigger coordinator have no
// knowledge of React, AppState, NetInfo, SSE or Zustand, and this module is the only
// place that does.
//
// §14.2's flag gates TRIGGER REGISTRATION, not merely the engine body. That matters: both
// the v1 bulk-download path and v2 would otherwise be writing an offline copy of the same
// mail from different cursors, so they must never run concurrently.

import { AppState, type AppStateStatus } from 'react-native';

import { jmapClient } from '../api/jmap-client';
import type { StateChange } from '../api/types';
import { useAuthStore } from '../stores/auth-store';
import { useNetworkStore } from '../stores/network-store';
import { useOutboxStore } from '../stores/outbox-store';
import { useSettingsStore } from '../stores/settings-store';
import { useSyncStatusStore } from '../stores/sync-status-store';
import { getSyncEngine, resetSyncEngineForTests, type EngineDeps, type SyncEngine } from './engine';
import type { PendingOp } from './overlay';
import type { RetentionPolicy } from './retention';
import { sqliteStoreFactory } from './store-sqlite';
import { TriggerCoordinator, type TriggerDeps } from './triggers';

export interface SyncWiring {
  engine: SyncEngine;
  coordinator: TriggerCoordinator;
  /** Route a pushed StateChange in (T5). */
  onStateChange(change: StateChange): void;
  stop(): void;
}

let active: SyncWiring | null = null;

/** The live wiring, when the flag is on. Null otherwise. */
export function currentSyncWiring(): SyncWiring | null {
  return active;
}

function localAccountId(): string | null {
  return useAuthStore.getState().activeAccountId;
}

function retentionPolicy(): RetentionPolicy {
  const s = useSettingsStore.getState();
  return {
    envelopeDays: s.offlineEnvelopeDays,
    bodyDays: s.offlineBodyDays,
    maxBodyMB: s.offlineCacheMaxMB,
  };
}

function pendingOpsFor(): readonly PendingOp[] {
  return useOutboxStore.getState().entries.map((e) => e.op);
}

export function buildEngineDeps(): EngineDeps {
  return {
    factory: sqliteStoreFactory,
    // v1 syncs the PRIMARY mail account only (§8.2); shared/group accounts stay
    // online-only, as they effectively are today.
    jmapAccountIdFor: (accountId) =>
      accountId === localAccountId() ? (jmapClient.accountId ?? null) : null,
    retentionFor: () => retentionPolicy(),
    // §9.5: a disabled account's store is never opened, let alone materialised.
    isEnabled: () => useSettingsStore.getState().offlineCacheEnabled,
    // §7.3: offline is not an error — a cycle simply does not start.
    isOnline: () => useNetworkStore.getState().online,
    hasLiveSession: () => useAuthStore.getState().session != null,
    pendingOpsFor: () => pendingOpsFor(),
    log: (level, message) => {
      if (level === 'error') console.error('[sync]', message);
      else if (level === 'warn') console.warn('[sync]', message);
      else console.log('[sync]', message);
    },
    onPhase: (_accountId, phase) => useSyncStatusStore.getState().notePhase(phase),
    onReport: (report) => {
      useSyncStatusStore.getState().noteReport(report);
      // §10.3's chaining lives in the coordinator, so hand the report over.
      active?.coordinator.onCycleFinished(report);
    },
  };
}

function buildTriggerDeps(engine: SyncEngine): TriggerDeps {
  return {
    engine,
    activeAccounts: () => {
      const id = localAccountId();
      return id ? [id] : [];
    },
    jmapAccountIdFor: (accountId) =>
      accountId === localAccountId() ? (jmapClient.accountId ?? null) : null,
    // §10.4's equality dedupe needs our LAST APPLIED state. Reading it from the engine's
    // own store would mean an async hop on every push; the status store's last report
    // does not carry cursors, so return null and accept a redundant cycle instead of a
    // skipped one. Erring toward "wake up" is the safe direction: the cost is one
    // round-trip, and the pushed state is never written as a cursor either way.
    cursorState: () => null,
    log: (level, message) => {
      if (level === 'error') console.error('[sync/trigger]', message);
      else if (level === 'warn') console.warn('[sync/trigger]', message);
      else console.log('[sync/trigger]', message);
    },
  };
}

/**
 * Register every §10 trigger and return a teardown.
 *
 * Called only when `offlineSyncEngineV2` is on AND there is a live session; the caller
 * (App.tsx) re-runs it when either changes.
 */
export function startSyncEngine(): SyncWiring {
  if (active) return active;

  const engine = getSyncEngine(buildEngineDeps());
  const coordinator = new TriggerCoordinator(buildTriggerDeps(engine));
  const teardowns: Array<() => void> = [];

  // T1 — live session established (cold start). The coordinator applies §10.1's 2 s
  // debounce, which keeps today's behaviour of not competing with the inbox load.
  coordinator.fire('session');

  // T2 — app foreground. Throttled to once per 30 s by the coordinator.
  const appStateSub = AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'active') {
      coordinator.fire('foreground');
      return;
    }
    // Backgrounding aborts at the next page boundary, leaving a committed cursor and
    // resumable state (§10.3).
    const id = localAccountId();
    if (id) coordinator.onAbortCondition(id, 'app backgrounded');
  });
  teardowns.push(() => appStateSub.remove());

  // T4 — network regained. Debounced with per-account jitter, because this trigger fires
  // for everything at once and is the classic stampede shape (§7.2).
  teardowns.push(
    useNetworkStore.subscribe((state, prev) => {
      if (state.online && !prev.online) coordinator.fire('network');
      else if (!state.online && prev.online) {
        const id = localAccountId();
        if (id) coordinator.onAbortCondition(id, 'network lost');
      }
    }),
  );

  // T6 — retention settings changed. Never throttled: a setting change must take effect.
  let lastPolicy = retentionPolicy();
  teardowns.push(
    useSettingsStore.subscribe(() => {
      const next = retentionPolicy();
      if (
        next.envelopeDays !== lastPolicy.envelopeDays ||
        next.bodyDays !== lastPolicy.bodyDays ||
        next.maxBodyMB !== lastPolicy.maxBodyMB
      ) {
        lastPolicy = next;
        coordinator.fire('retention');
      }
      // T10 — the feature being switched off aborts the cycle; §8.4's purge is the
      // Settings screen's job (it needs the destructive confirmation).
      if (!useSettingsStore.getState().offlineCacheEnabled) {
        const id = localAccountId();
        if (id) coordinator.onFeatureDisabled(id);
      }
    }),
  );

  active = {
    engine,
    coordinator,
    onStateChange: (change) => coordinator.onStateChange(change),
    stop: () => {
      for (const teardown of teardowns) teardown();
      const id = localAccountId();
      if (id) coordinator.onAbortCondition(id, 'engine stopped');
      active = null;
      useSyncStatusStore.getState().reset();
    },
  };
  return active;
}

export function stopSyncEngine(): void {
  active?.stop();
}

/**
 * Completes any purge left pending by a crash, and purges an account whose store format
 * no longer matches this build — BOTH before any cycle can start (§8.4, §8.4.1).
 */
export async function prepareSyncStores(): Promise<void> {
  try {
    await sqliteStoreFactory.completePendingPurges();
  } catch (err) {
    console.warn('[sync] completePendingPurges failed', err);
  }
}

/** Tests only. */
export function resetSyncWiringForTests(): void {
  active = null;
  resetSyncEngineForTests();
}
