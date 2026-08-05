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
  /**
   * False while the floor we are using came from a SUSPECT clock reading. Eviction and
   * the reconcile sweep must both refuse to act on it.
   */
  evictionAllowed: boolean;
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
  opts: { policyChanged?: boolean } = {},
): GuardedFloor {
  const adopt = (floor: string): GuardedFloor => ({
    envelopeFrom: floor,
    suppressed: false,
    evictionAllowed: true,
    nextLastWindowFloor: floor,
  });

  if (!lastWindowFloor) return adopt(computed);

  // An explicit `envelopeDays` change is INTENT, not a glitch, and must take effect —
  // including its eviction. This is also why the previous "adopt on the second
  // observation" rule had to go: with intent handled here, second-observation adoption
  // existed ONLY for the clock-anomaly case, i.e. only for the case where adopting is
  // the harmful thing to do.
  if (opts.policyChanged) return adopt(computed);

  const delta = Math.abs(Date.parse(computed) - Date.parse(lastWindowFloor));
  if (!Number.isFinite(delta) || delta <= CLOCK_JUMP_GUARD_MS) return adopt(computed);

  // SUSPECT. Ignore the reading entirely and keep the previous floor.
  //
  // Persisting the COMPUTED value here was the H2 bug: the next chained cycle (T9, ~5 s
  // later) computed a floor within 5 s of the persisted one, which is inside this
  // threshold, so it was adopted as legitimate, classified as a retention NARROW, and
  // every envelope below it was evicted. A clock glitch wiped the entire offline store
  // about five seconds after being detected — through the very mechanism meant to
  // prevent that.
  //
  // Persisting the PREVIOUS value instead means every subsequent cycle re-detects the
  // same jump and stays suppressed. The trade-off, stated plainly: on a device whose
  // clock is permanently wrong by more than a day, retention stops tracking the clock
  // and the store keeps more mail than the setting says. That is bounded — envelopes
  // are ~1 KB and bodies are capped in bytes — and it self-clears the moment the user
  // changes a retention setting (`policyChanged`) or the clock returns. Keeping too
  // much mail is the correct direction to fail for a feature whose entire purpose is
  // having mail available offline.
  return {
    envelopeFrom: lastWindowFloor,
    suppressed: true,
    evictionAllowed: false,
    nextLastWindowFloor: lastWindowFloor,
    warning:
      `retention floor moved ${Math.round(delta / 3_600_000)}h ` +
      `(${lastWindowFloor} -> ${computed}) with no retention-setting change; ` +
      'treating it as a device-clock anomaly, holding the previous floor and ' +
      'suppressing eviction (F44)',
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
