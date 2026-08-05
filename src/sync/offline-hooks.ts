// The reactive half of the v1/v2 branch. `offline-facade.ts` owns the actions; this owns
// what the UI renders, so neither the banner nor the Settings screen contains a flag check
// of its own.
//
// Every selector below returns a PRIMITIVE. That is not stylistic: the first version of the
// banner used `useSyncStatusStore((s) => ({ ... }))`, and a fresh object literal per render
// is treated as a changed snapshot by `useSyncExternalStore`, which produced a real
// "Maximum update depth exceeded" render loop on device. Primitive selectors cannot have
// that failure mode at all, which is a stronger guarantee than remembering `useShallow`.

import React from 'react';

import { useOfflineCacheStore, type SyncPhase } from '../stores/offline-cache-store';
import { useSettingsStore } from '../stores/settings-store';
import { useSyncStatusStore } from '../stores/sync-status-store';
import { offlineStats, type OfflineStats } from './offline-facade';

/**
 * The reactive form of `offlineEngineOwnsStore()`. Two primitive selectors rather than one
 * derived object, so the snapshot is stable (see the header).
 */
export function useOfflineEngineActive(): boolean {
  const flag = useSettingsStore((s) => s.offlineSyncEngineV2);
  const enabled = useSettingsStore((s) => s.offlineCacheEnabled);
  return flag && enabled;
}

export interface OfflineSyncView {
  engineActive: boolean;
  /** Mapped onto the five phases the existing UI already renders. */
  phase: SyncPhase;
  /** Phase-specific detail, or the error message. */
  message?: string;
  completed: number;
  total: number;
  bytes: number;
  fetched: number;
  finishedAt?: number;
  busy: boolean;
  /** v2 is cursor-driven, so there is no honest denominator for a progress bar. */
  indeterminate: boolean;
  canCancel: boolean;
  cancel: () => void;
  dismiss: () => void;
}

/** §12.3's mapping from the engine's phases onto the five the UI knows. */
const V2_PHASES: Record<string, { phase: SyncPhase; label?: string }> = {
  idle: { phase: 'idle' },
  bootstrapping: { phase: 'scanning', label: 'Downloading your mail history…' },
  coverage: { phase: 'scanning', label: 'Filling in older messages…' },
  resyncing: { phase: 'scanning', label: 'Re-syncing offline mail…' },
  delta: { phase: 'fetching', label: 'Checking for changes…' },
  bodies: { phase: 'fetching', label: 'Downloading message bodies…' },
  partial: { phase: 'fetching', label: 'Paused — will continue shortly' },
  done: { phase: 'done' },
  error: { phase: 'error' },
};

export function useOfflineSyncView(): OfflineSyncView {
  const engineActive = useOfflineEngineActive();

  // v1 — primitives only.
  const v1Phase = useOfflineCacheStore((s) => s.sync.phase);
  const v1Total = useOfflineCacheStore((s) => s.sync.total);
  const v1Completed = useOfflineCacheStore((s) => s.sync.completed);
  const v1Fetched = useOfflineCacheStore((s) => s.sync.fetched);
  const v1Bytes = useOfflineCacheStore((s) => s.sync.bytes);
  const v1Message = useOfflineCacheStore((s) => s.sync.message);
  const v1FinishedAt = useOfflineCacheStore((s) => s.sync.finishedAt);
  const v1Abort = useOfflineCacheStore((s) => s.requestAbort);
  const v1Reset = useOfflineCacheStore((s) => s.resetSync);

  // v2 — primitives only.
  const v2Phase = useSyncStatusStore((s) => s.phase);
  const v2Message = useSyncStatusStore((s) => s.message);
  const v2FinishedAt = useSyncStatusStore((s) => s.finishedAt);
  const v2Reset = useSyncStatusStore((s) => s.reset);

  return React.useMemo<OfflineSyncView>(() => {
    if (!engineActive) {
      const busy = v1Phase === 'scanning' || v1Phase === 'fetching';
      return {
        engineActive: false,
        phase: v1Phase,
        message: v1Message,
        completed: v1Completed,
        total: v1Total,
        bytes: v1Bytes,
        fetched: v1Fetched,
        finishedAt: v1FinishedAt,
        busy,
        indeterminate: false,
        canCancel: busy,
        cancel: v1Abort,
        dismiss: v1Reset,
      };
    }

    const mapped = V2_PHASES[v2Phase] ?? { phase: 'idle' as SyncPhase };
    const busy = mapped.phase === 'scanning' || mapped.phase === 'fetching';
    return {
      engineActive: true,
      phase: mapped.phase,
      message: v2Phase === 'error' ? v2Message : mapped.label,
      completed: 0,
      total: 0,
      bytes: 0,
      fetched: 0,
      finishedAt: v2FinishedAt,
      busy,
      indeterminate: busy,
      // A v2 cycle aborts at the next page boundary and resumes on its own via T9, so
      // there is no meaningful "cancel" to offer — only dismissing the bar.
      canCancel: false,
      cancel: () => undefined,
      dismiss: v2Reset,
    };
  }, [
    engineActive,
    v1Phase, v1Total, v1Completed, v1Fetched, v1Bytes, v1Message, v1FinishedAt,
    v1Abort, v1Reset,
    v2Phase, v2Message, v2FinishedAt, v2Reset,
  ]);
}

/**
 * "How much mail is on this device", from whichever store actually holds it.
 *
 * v2's count is a SQL query, so it cannot be a synchronous selector — hence the fetch on
 * mount plus a re-fetch whenever a cycle settles. That is also what makes the number update
 * after a sync without the user leaving the screen.
 */
export function useOfflineStats(): OfflineStats & { refresh: () => void } {
  const engineActive = useOfflineEngineActive();
  const v1Count = useOfflineCacheStore((s) => s.totalCount());
  const v1Bytes = useOfflineCacheStore((s) => s.totalSize());
  // Re-read when a cycle finishes, which is when the numbers can have changed.
  const v2Phase = useSyncStatusStore((s) => s.phase);
  const [v2, setV2] = React.useState<OfflineStats>({ count: 0, bytes: 0, source: 'v2' });
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    if (!engineActive) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await offlineStats();
        if (!cancelled) setV2(next);
      } catch (err) {
        console.warn('[sync] offline stats failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engineActive, v2Phase, nonce]);

  const refresh = React.useCallback(() => setNonce((n) => n + 1), []);

  if (!engineActive) return { count: v1Count, bytes: v1Bytes, source: 'v1', refresh };
  return { ...v2, refresh };
}
