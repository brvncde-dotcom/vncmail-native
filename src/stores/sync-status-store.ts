// §12.3's new store: phase/progress/error for the banner.
//
// An OBSERVER of the engine, never an input to it. §10.5 requires the engine to be
// callable headless with no dependency on React or a Zustand store for correctness, so
// nothing here may feed back into a cycle — this store is written to and read from, and
// the engine never reads it.

import { create } from 'zustand';

import type { CycleReport } from '../sync/engine';

/**
 * The design's five new phases (§12.3), plus the two terminal states the existing banner
 * already knows how to render.
 */
export type EngineSyncPhase =
  | 'idle'
  | 'bootstrapping'
  | 'delta'
  | 'coverage'
  | 'bodies'
  | 'resyncing'
  | 'partial'
  | 'done'
  | 'error';

export interface EngineSyncStatus {
  phase: EngineSyncPhase;
  /** Human-readable detail; the error message when phase is 'error'. */
  message?: string;
  startedAt?: number;
  finishedAt?: number;
  /** True when work remains, so the banner can say "paused" rather than "done". */
  unfinished: boolean;
  /** From a rate-limited server: the banner can explain the wait (§7.2). */
  retryAfterMs?: number;
}

const IDLE: EngineSyncStatus = { phase: 'idle', unfinished: false };

/** Maps an engine phase name onto the coarse phase the banner renders. */
function phaseFor(name: string): EngineSyncPhase {
  if (name === 'bootstrap') return 'bootstrapping';
  if (name.startsWith('delta:')) return 'delta';
  if (name === 'coverage:reconciling' || name === 'reconcile-start' || name === 'reconcile-sweep') {
    return 'resyncing';
  }
  if (name.startsWith('coverage:')) return 'coverage';
  if (name.startsWith('bodies:')) return 'bodies';
  if (name.startsWith('retention:')) return 'coverage';
  return 'delta';
}

interface SyncStatusState extends EngineSyncStatus {
  lastReport: CycleReport | null;
  /** Called as each engine phase begins. */
  notePhase: (phase: string) => void;
  /** Called once per finished cycle. */
  noteReport: (report: CycleReport) => void;
  reset: () => void;
}

export const useSyncStatusStore = create<SyncStatusState>((set, get) => ({
  ...IDLE,
  lastReport: null,

  notePhase: (name) => {
    const current = get();
    set({
      phase: phaseFor(name),
      startedAt: current.startedAt ?? Date.now(),
      finishedAt: undefined,
      message: undefined,
    });
  },

  noteReport: (report) => {
    // `abandoned` is not a failure — §7.3: offline, no session, or the feature disabled
    // means a cycle does not start, and the OfflineBanner already tells the user why.
    if (report.outcome === 'abandoned') {
      set({ ...IDLE, lastReport: report });
      return;
    }
    if (report.outcome === 'failed') {
      set({
        phase: 'error',
        message: report.error,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        unfinished: report.unfinishedWork,
        retryAfterMs: report.retryAfterMs,
        lastReport: report,
      });
      return;
    }
    if (report.unfinishedWork) {
      // Not an error: exceeding a budget is a NORMAL outcome (§6.4) and T9 resumes.
      set({
        phase: 'partial',
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        unfinished: true,
        retryAfterMs: report.retryAfterMs,
        lastReport: report,
      });
      return;
    }
    set({
      phase: 'done',
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      unfinished: false,
      message: undefined,
      retryAfterMs: undefined,
      lastReport: report,
    });
  },

  reset: () => set({ ...IDLE, lastReport: get().lastReport }),
}));
