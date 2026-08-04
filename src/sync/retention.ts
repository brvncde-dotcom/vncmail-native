// Retention policy: the two-window split of §2.1, the MB cap, and the F44
// clock-jump guard. Pure — no store reads, no clock reads except through the
// injected `now`, so every rule here is unit-testable.
//
// §2.1's resolved human decision: the envelope and body windows are SEPARATE
// settings and envelope retention is widened well beyond body retention. The MB
// cap applies to bodies only, so a widened envelope window costs kilobytes per
// message and never evicts a message out of the offline list.
//
// The policy arrives as a VALUE, not by reading `settings-store`. §10.5 requires
// the engine to be callable headless with no dependency on React or a Zustand
// store for correctness, and a retention window is exactly the kind of input that
// a background task must be able to supply itself.

/** §2.1: `offlineEnvelopeDays` / `offlineBodyDays`, plus the bodies-only MB cap. */
export interface RetentionPolicy {
  envelopeDays: number;
  bodyDays: number;
  maxBodyMB: number;
}

export interface RetentionFloors {
  /** ISO. Oldest receivedAt the ENVELOPE tier should hold. */
  envelopeFrom: string;
  /** ISO. Oldest receivedAt the BODY tier should hold. */
  bodyFrom: string;
  maxBodyBytes: number;
}

/**
 * F44's threshold. A day of slack plus an hour, so an ordinary DST shift or a
 * modest NTP correction does not trip it, but a year-long jump does.
 */
export const CLOCK_JUMP_GUARD_MS = 25 * 60 * 60 * 1000;

function isoDaysAgo(now: number, days: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

export function computeFloors(policy: RetentionPolicy, now: number): RetentionFloors {
  // The body window can never be wider than the envelope window: a body with no
  // envelope is an orphan by construction (F45), and §2.1's whole point is
  // envelopes ⊇ bodies.
  const bodyDays = Math.min(policy.bodyDays, policy.envelopeDays);
  return {
    envelopeFrom: isoDaysAgo(now, policy.envelopeDays),
    bodyFrom: isoDaysAgo(now, bodyDays),
    maxBodyBytes: Math.max(0, Math.floor(policy.maxBodyMB * 1024 * 1024)),
  };
}

export interface GuardedFloor {
  /** The floor to actually use for eviction and for any sweep. */
  envelopeFrom: string;
  /** True when the guard suppressed a suspicious jump. */
  suppressed: boolean;
  /** What to persist as `lastWindowFloor` (§3.1). */
  nextLastWindowFloor: string;
  warning?: string;
}

/**
 * F44 — the device-clock jump guard.
 *
 * I8 narrows to: no CURSOR or ordering depends on the device clock (cursors are
 * opaque server strings, `scanCursor` is a server `receivedAt`). But the retention
 * BOUNDARY does read the clock, so a large skew can move the window. Revision 1's
 * blanket "no correctness impact" was too strong for a feature whose entire point
 * is having mail available while offline.
 *
 * Rule: if the computed floor moves more than 25 h from `lastWindowFloor`, keep
 * the PREVIOUS floor and warn, until a second consistent observation. That turns a
 * clock glitch into a one-cycle delay instead of a delete-and-redownload of the
 * whole window.
 */
export function guardFloorAgainstClockJump(
  computed: string,
  lastWindowFloor: string | undefined,
  opts: { alreadyConfirmed?: boolean } = {},
): GuardedFloor {
  if (!lastWindowFloor) {
    return { envelopeFrom: computed, suppressed: false, nextLastWindowFloor: computed };
  }
  const delta = Math.abs(Date.parse(computed) - Date.parse(lastWindowFloor));
  if (!Number.isFinite(delta) || delta <= CLOCK_JUMP_GUARD_MS) {
    return { envelopeFrom: computed, suppressed: false, nextLastWindowFloor: computed };
  }
  if (opts.alreadyConfirmed) {
    // Second consistent observation — the clock really did move (or the user
    // really did change the setting). Adopt it.
    return { envelopeFrom: computed, suppressed: false, nextLastWindowFloor: computed };
  }
  return {
    envelopeFrom: lastWindowFloor,
    suppressed: true,
    // Record the COMPUTED value so the next cycle can recognise a repeat and
    // adopt it; recording the old value would make the guard permanent.
    nextLastWindowFloor: computed,
    warning:
      `retention floor moved ${Math.round(delta / 3_600_000)}h ` +
      `(${lastWindowFloor} -> ${computed}); holding the previous floor for one cycle (F44)`,
  };
}

/** A widen moves the floor BACK in time; a narrow moves it forward. */
export function floorMovement(
  previous: string | null | undefined,
  next: string,
): 'widened' | 'narrowed' | 'unchanged' {
  if (!previous) return 'widened';
  const a = Date.parse(previous);
  const b = Date.parse(next);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return 'unchanged';
  return b < a ? 'widened' : 'narrowed';
}

/** How many bytes of body must be shed to get back under the cap (F25). */
export function bytesToEvict(totalBytes: number, maxBodyBytes: number): number {
  return Math.max(0, totalBytes - maxBodyBytes);
}

/**
 * Pick oldest-body-first until the overage is covered (F25). Envelopes always
 * survive, so a message stays listed and openable-online after its body is shed.
 */
export function selectBodiesToEvict<T extends { bytes: number }>(
  oldestFirst: readonly T[],
  overageBytes: number,
): T[] {
  if (overageBytes <= 0) return [];
  const out: T[] = [];
  let freed = 0;
  for (const candidate of oldestFirst) {
    out.push(candidate);
    freed += candidate.bytes;
    if (freed >= overageBytes) break;
  }
  return out;
}
