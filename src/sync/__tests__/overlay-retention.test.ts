// §5.6 read-time overlay (F28/F29) and §2.1 retention (F23/F23B/F24B/F25/F44).

import { describe, expect, it } from 'vitest';

import {
  adjustForWindow,
} from '../coverage';
import {
  applyPendingOps,
  applyPendingOpsToList,
  hasPendingDestroy,
  indexPendingOps,
  type PendingOp,
} from '../overlay';
import {
  bytesToEvict,
  CLOCK_JUMP_GUARD_MS,
  computeFloors,
  floorMovement,
  guardFloorAgainstClockJump,
  selectBodiesToEvict,
} from '../retention';
import type { CoverageState } from '../store';

const JA = 'jmap-acct-1';

function record(id: string, over: Record<string, unknown> = {}) {
  return { id, keywords: {}, mailboxIds: { inbox: true }, ...over };
}

describe('§5.6 read-time overlay', () => {
  it('returns the record untouched when nothing is pending', () => {
    const r = record('A');
    expect(applyPendingOps(r, undefined)).toBe(r);
    expect(applyPendingOps(r, [])).toBe(r);
  });

  it('applies a pending keywords op over server truth', () => {
    // The durable store holds SERVER-DERIVED state only; nothing optimistic is ever
    // written into envelope/body. This is the composition that replaces the
    // write-through §5.6 deleted.
    const overlaid = applyPendingOps(record('A', { keywords: {} }), [
      { kind: 'keywords', emailId: 'A', keywords: { $seen: true } },
    ]);
    expect(overlaid?.keywords).toEqual({ $seen: true });
  });

  it('applies a pending mailboxes op', () => {
    const overlaid = applyPendingOps(record('A'), [
      { kind: 'mailboxes', emailId: 'A', mailboxIds: { archive: true } },
    ]);
    expect(overlaid?.mailboxIds).toEqual({ archive: true });
  });

  it('a pending destroy hides the record from reads without deleting it (I7)', () => {
    expect(applyPendingOps(record('A'), [{ kind: 'destroy', emailId: 'A' }])).toBeNull();
  });

  it('last-write-wins across coalesced ops, in queue order', () => {
    // Each primitive assigns the WHOLE target state rather than a delta, so
    // replaying in order is safe and the latest is authoritative.
    const overlaid = applyPendingOps(record('A'), [
      { kind: 'keywords', emailId: 'A', keywords: { $seen: true } },
      { kind: 'keywords', emailId: 'A', keywords: { $flagged: true } },
    ]);
    expect(overlaid?.keywords).toEqual({ $flagged: true });
  });

  it('a destroy anywhere in the queue wins (F29)', () => {
    const overlaid = applyPendingOps(record('A'), [
      { kind: 'keywords', emailId: 'A', keywords: { $seen: true } },
      { kind: 'destroy', emailId: 'A' },
    ]);
    expect(overlaid).toBeNull();
  });

  it('delta can never revert an unflushed local mutation (F28)', () => {
    // Cannot happen BY CONSTRUCTION: the delta path has no knowledge of pending ops
    // (they are not a parameter to apply()), and the overlay is re-applied at every
    // read. So a server row that still says unread still READS as read.
    const serverTruthAfterDelta = record('A', { keywords: {} });
    const pending: PendingOp[] = [{ kind: 'keywords', emailId: 'A', keywords: { $seen: true } }];
    expect(applyPendingOps(serverTruthAfterDelta, pending)?.keywords).toEqual({ $seen: true });
    // And once the flush lands and the op leaves the queue, the overlay disappears
    // on its own — no cleanup step, no second durable copy to reconcile.
    expect(applyPendingOps(record('A', { keywords: { $seen: true } }), [])?.keywords).toEqual({
      $seen: true,
    });
  });

  it('overlays a list and drops destroyed rows, shortening the page', () => {
    const rows = [record('A'), record('B'), record('C')];
    const pending = indexPendingOps([
      { kind: 'destroy', emailId: 'B' },
      { kind: 'keywords', emailId: 'C', keywords: { $seen: true } },
    ]);
    const out = applyPendingOpsToList(rows, pending);
    expect(out.map((r) => r.id)).toEqual(['A', 'C']);
    expect(out[1].keywords).toEqual({ $seen: true });
  });

  it('does not mutate its inputs', () => {
    const rows = [record('A', { keywords: {} })];
    const pending = indexPendingOps([
      { kind: 'keywords', emailId: 'A', keywords: { $seen: true } },
    ]);
    applyPendingOpsToList(rows, pending);
    expect(rows[0].keywords).toEqual({});
  });

  it('indexes ops by email id and reports pending destroys', () => {
    const index = indexPendingOps([
      { kind: 'destroy', emailId: 'A' },
      { kind: 'keywords', emailId: 'B', keywords: {} },
    ]);
    expect(hasPendingDestroy(index.get('A'))).toBe(true);
    expect(hasPendingDestroy(index.get('B'))).toBe(false);
    expect(hasPendingDestroy(index.get('C'))).toBe(false);
  });
});

describe('§2.1 retention floors', () => {
  const NOW = Date.parse('2026-08-04T00:00:00.000Z');

  it('computes independent envelope and body floors', () => {
    const floors = computeFloors({ envelopeDays: 365, bodyDays: 30, maxBodyMB: 50 }, NOW);
    expect(floors.envelopeFrom).toBe('2025-08-04T00:00:00.000Z');
    expect(floors.bodyFrom).toBe('2026-07-05T00:00:00.000Z');
    expect(floors.maxBodyBytes).toBe(50 * 1024 * 1024);
  });

  it('never lets the body window outgrow the envelope window', () => {
    // A body with no envelope is an orphan by construction (F45), and §2.1's whole
    // point is envelopes ⊇ bodies.
    const floors = computeFloors({ envelopeDays: 7, bodyDays: 90, maxBodyMB: 50 }, NOW);
    expect(floors.bodyFrom).toBe(floors.envelopeFrom);
  });

  it('classifies floor movement: back in time is a widen', () => {
    expect(floorMovement('2026-07-01T00:00:00Z', '2026-06-01T00:00:00Z')).toBe('widened');
    expect(floorMovement('2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z')).toBe('narrowed');
    expect(floorMovement('2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')).toBe('unchanged');
    expect(floorMovement(null, '2026-07-01T00:00:00Z')).toBe('widened');
  });
});

describe('F44 clock-jump guard', () => {
  it('accepts a first observation with no history', () => {
    const g = guardFloorAgainstClockJump('2026-07-01T00:00:00Z', undefined);
    expect(g.suppressed).toBe(false);
    expect(g.envelopeFrom).toBe('2026-07-01T00:00:00Z');
  });

  it('accepts an ordinary drift (a day of slack absorbs DST and NTP)', () => {
    const g = guardFloorAgainstClockJump('2026-07-02T00:00:00Z', '2026-07-01T00:00:00Z');
    expect(g.suppressed).toBe(false);
  });

  it('HOLDS the previous floor on a large jump and warns', () => {
    // Otherwise a skew triggers a delete-and-redownload of the whole window —
    // for a feature whose entire point is having mail available offline.
    const g = guardFloorAgainstClockJump('2027-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
    expect(g.suppressed).toBe(true);
    expect(g.envelopeFrom).toBe('2026-07-01T00:00:00Z');
    expect(g.warning).toMatch(/holding the previous floor/);
  });

  it('records the COMPUTED value so the guard cannot become permanent', () => {
    const first = guardFloorAgainstClockJump('2027-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
    expect(first.suppressed).toBe(true);
    // Next cycle sees the same computed value as lastWindowFloor -> confirmed.
    const second = guardFloorAgainstClockJump('2027-07-01T00:00:00Z', first.nextLastWindowFloor, {
      alreadyConfirmed: true,
    });
    expect(second.suppressed).toBe(false);
    expect(second.envelopeFrom).toBe('2027-07-01T00:00:00Z');
  });

  it('trips exactly at the documented threshold', () => {
    const base = Date.parse('2026-07-01T00:00:00.000Z');
    const under = new Date(base + CLOCK_JUMP_GUARD_MS).toISOString();
    const over = new Date(base + CLOCK_JUMP_GUARD_MS + 1).toISOString();
    expect(guardFloorAgainstClockJump(under, '2026-07-01T00:00:00.000Z').suppressed).toBe(false);
    expect(guardFloorAgainstClockJump(over, '2026-07-01T00:00:00.000Z').suppressed).toBe(true);
  });
});

describe('F25 body eviction selection', () => {
  it('computes the overage against the cap', () => {
    expect(bytesToEvict(100, 60)).toBe(40);
    expect(bytesToEvict(50, 60)).toBe(0);
  });

  it('takes oldest-first until the overage is covered, and no further', () => {
    const oldest = [
      { key: { jmapAccountId: JA, id: 'A' }, receivedAt: '2026-01-01', bytes: 30 },
      { key: { jmapAccountId: JA, id: 'B' }, receivedAt: '2026-02-01', bytes: 30 },
      { key: { jmapAccountId: JA, id: 'C' }, receivedAt: '2026-03-01', bytes: 30 },
    ];
    expect(selectBodiesToEvict(oldest, 40).map((v) => v.key.id)).toEqual(['A', 'B']);
    expect(selectBodiesToEvict(oldest, 0)).toEqual([]);
    expect(selectBodiesToEvict(oldest, 1000).map((v) => v.key.id)).toEqual(['A', 'B', 'C']);
  });
});

describe('retention window adjustment — F23 / F23B / F38', () => {
  function coverage(over: Partial<CoverageState> = {}): CoverageState {
    return {
      jmapAccountId: JA,
      coveredFrom: '2026-07-01T00:00:00Z',
      scanCursor: null,
      targetFrom: '2026-07-01T00:00:00Z',
      phase: 'complete',
      seen: 10,
      consecutiveFailures: 0,
      updatedAt: 0,
      ...over,
    };
  }

  it('a widen resumes the scan and never touches the cursors (F23)', () => {
    const adj = adjustForWindow(coverage(), '2026-01-01T00:00:00Z');
    expect(adj.patch).toMatchObject({
      targetFrom: '2026-01-01T00:00:00Z',
      phase: 'scanning',
    });
    expect(adj.evictBelow).toBeUndefined();
  });

  it('a narrow evicts below the new floor (F23B)', () => {
    const adj = adjustForWindow(coverage(), '2026-08-01T00:00:00Z');
    expect(adj.patch).toMatchObject({
      targetFrom: '2026-08-01T00:00:00Z',
      coveredFrom: '2026-08-01T00:00:00Z',
    });
    expect(adj.evictBelow).toBe('2026-08-01T00:00:00Z');
  });

  it('does nothing when the floor has not moved', () => {
    expect(adjustForWindow(coverage(), '2026-07-01T00:00:00Z').patch).toEqual({});
  });

  it('DEFERS a widen that arrives mid-reconcile — S2/F38, the data-loss guard', () => {
    // This is the branch that made F38 a PERMANENT data-loss bug before revision 2.
    // Applying the widen now would make the sweep run against the new, wider floor
    // while the enumeration only covered the old, narrower one — deleting every
    // record in the gap. Permanently: coveredFrom would then claim that range
    // complete, and delta sync cannot re-deliver pre-existing mail.
    const adj = adjustForWindow(
      coverage({ phase: 'reconciling', sweepFloor: '2026-07-01T00:00:00Z' }),
      '2026-01-01T00:00:00Z',
    );
    expect(adj.patch).toEqual({ deferredTargetFrom: '2026-01-01T00:00:00Z' });
    // Critically: targetFrom and sweepFloor are NOT in the patch.
    expect(adj.patch).not.toHaveProperty('targetFrom');
    expect(adj.patch).not.toHaveProperty('sweepFloor');
    expect(adj.evictBelow).toBeUndefined();
    expect(adj.note).toMatch(/deferred/);
  });

  it('defers a NARROW mid-reconcile too, rather than racing the sweep', () => {
    const adj = adjustForWindow(
      coverage({ phase: 'reconciling', sweepFloor: '2026-07-01T00:00:00Z' }),
      '2026-08-01T00:00:00Z',
    );
    expect(adj.patch).toEqual({ deferredTargetFrom: '2026-08-01T00:00:00Z' });
    expect(adj.evictBelow).toBeUndefined();
  });
});
