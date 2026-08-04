// The §7.1 error taxonomy and §7.2 backoff.
//
// The whole point of this file is the last column of §7.1's table: **exactly one
// error class moves the cursor**, and its action is a full verified rebuild.
// Everywhere else failure means the cursor stands still. That is what makes "a
// failure never causes silent data loss" structural rather than aspirational —
// and it is precisely what defect D4 got wrong in shipped code, by collapsing
// every error to `null` and then adopting a snapshot state as the next cursor.

import { AuthenticationError, RateLimitError } from '../api/jmap-client';

export type ErrorClass =
  | 'Transport'
  | 'RateLimit'
  | 'ServerTransient'
  | 'RequestLimit'
  | 'Auth'
  | 'Fatal'
  | 'StateInvalid';

export interface Classified {
  class: ErrorClass;
  /** The JMAP method-level error type, when we could identify one. */
  jmapType?: string;
  /** From a 429's `Retry-After`; always overrides a smaller computed delay. */
  retryAfterMs?: number;
  retryable: boolean;
  message: string;
}

/**
 * `cannotCalculateChanges` is the one method-level error the on-`main` API
 * surfaces as a value (`null`) rather than a throw, because it is the only one
 * whose correct handling is "invalidate and rebuild" rather than "retry". Callers
 * convert that `null` into this, so both paths land in the same taxonomy.
 */
export class StateInvalidError extends Error {
  constructor(
    readonly reason: 'cannotCalculateChanges' | 'oldStateMismatch' | 'corruptState' | 'manual',
  ) {
    super(`sync state invalidated: ${reason}`);
    this.name = 'StateInvalidError';
  }
}

const SERVER_TRANSIENT_TYPES = new Set([
  'serverUnavailable',
  'serverFail',
  'serverPartialFail',
]);

const REQUEST_LIMIT_TYPES = new Set([
  'requestTooLarge',
  'maxSizeRequest',
  'maxCallsInRequest',
  'tooLarge',
]);

const FATAL_TYPES = new Set([
  'invalidArguments',
  'invalidResultReference',
  'unknownMethod',
  'accountNotFound',
  'accountNotSupportedByMethod',
  'accountReadOnly',
  'forbidden',
  'unsupportedFilter',
  'unsupportedSort',
]);

const RATE_LIMIT_TYPES = new Set(['rateLimit', 'tooManyRequests', 'overQuota']);

// Transport-level signals. Deliberately NOT using lib/network-error's
// `isTransientNetworkError`: that reads `network-store`, and §10.5 requires the
// engine to have no store dependency for CORRECTNESS. §7.3 handles "the device
// says it is offline" separately, before a cycle starts.
const TRANSPORT_NAMES = new Set(['NetworkError', 'AbortError', 'TypeError']);
const TRANSPORT_HINTS = [
  'network request failed',
  'network error',
  'failed to fetch',
  'not connected',
  'timeout',
  'timed out',
  'socket',
  'econnreset',
  'enotfound',
  'tls',
  'ssl',
];

/**
 * The api layer throws `Error("Email/changes failed: <type> - <description>")`,
 * so the JMAP error type has to be recovered from the message. Fragile-looking,
 * but it is the shape the typed-error fix on `main` produces and re-plumbing that
 * is a bigger change than this buys. `classifyJmapType` below is the seam: if the
 * api layer ever carries a structured type, only `extractJmapType` changes.
 */
function extractJmapType(message: string): string | undefined {
  // Anchored on the api layer's actual format — `Email/changes failed: <type>` — rather
  // than any message containing "failed:". The loose version matched
  // `fetch failed: ECONNRESET` and classified a socket reset as a JMAP method error.
  const m = /^[A-Za-z]+\/[A-Za-z]+ (?:failed|error):\s*([A-Za-z][A-Za-z0-9_]*)/.exec(message);
  return m?.[1];
}

function httpStatus(message: string): number | undefined {
  const m = /JMAP request failed:\s*(\d{3})/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/** Classify a JMAP error TYPE on its own — the part that is pure table lookup. */
export function classifyJmapType(type: string): ErrorClass {
  if (type === 'cannotCalculateChanges') return 'StateInvalid';
  if (type === 'stateMismatch') return 'StateInvalid';
  if (RATE_LIMIT_TYPES.has(type)) return 'RateLimit';
  if (SERVER_TRANSIENT_TYPES.has(type)) return 'ServerTransient';
  if (REQUEST_LIMIT_TYPES.has(type)) return 'RequestLimit';
  if (FATAL_TYPES.has(type)) return 'Fatal';
  // §7.1: an UNRECOGNISED method-level error is ServerTransient, never Fatal and
  // never StateInvalid. Guessing transient costs a retry; guessing state-invalid
  // costs a full resync; guessing fatal stalls the account. The cheapest wrong
  // answer wins the default.
  return 'ServerTransient';
}

export function classify(err: unknown): Classified {
  if (err instanceof StateInvalidError) {
    return {
      class: 'StateInvalid',
      jmapType: err.reason,
      retryable: false,
      message: err.message,
    };
  }
  if (err instanceof RateLimitError) {
    return {
      class: 'RateLimit',
      retryAfterMs: err.retryAfterMs,
      retryable: true,
      message: err.message,
    };
  }
  if (err instanceof AuthenticationError) {
    // §8.4: a 401 mid-cycle is NEVER a purge signal. A server hiccup returning
    // 401 must not delete a user's offline mail (F20).
    return { class: 'Auth', retryable: false, message: err.message };
  }
  if (!(err instanceof Error)) {
    return { class: 'ServerTransient', retryable: true, message: String(err) };
  }

  if (TRANSPORT_NAMES.has(err.name)) {
    return { class: 'Transport', retryable: true, message: err.message };
  }

  // L3: STRUCTURE BEFORE STRINGS. The transport hints are a substring match on the
  // message, and a method-level error's `description` can legitimately contain
  // "timeout", "socket" or "tls" — which used to misclassify it as Transport before the
  // HTTP status or JMAP error type was even looked at. Both are retryable in practice,
  // so this was not a live bug, but classification driven by prose that happens to
  // mention a network is not a property worth keeping.
  const status = httpStatus(err.message);
  if (status !== undefined) {
    if (status === 429) return { class: 'RateLimit', retryable: true, message: err.message };
    if (status === 401 || status === 403) {
      return { class: 'Auth', retryable: false, message: err.message };
    }
    if (status === 413) return { class: 'RequestLimit', retryable: true, message: err.message };
    if (status >= 500) return { class: 'ServerTransient', retryable: true, message: err.message };
    return { class: 'Fatal', retryable: false, message: err.message };
  }

  const type = extractJmapType(err.message);
  if (type) {
    const cls = classifyJmapType(type);
    return {
      class: cls,
      jmapType: type,
      retryable: cls === 'RateLimit' || cls === 'ServerTransient' || cls === 'RequestLimit',
      message: err.message,
    };
  }

  // Only now, with no status and no recognisable JMAP type, fall back to the prose.
  const lower = (err.message ?? '').toLowerCase();
  if (TRANSPORT_HINTS.some((h) => lower.includes(h))) {
    return { class: 'Transport', retryable: true, message: err.message };
  }

  return { class: 'ServerTransient', retryable: true, message: err.message };
}

/** True for the one class that moves a cursor — and it moves it to "invalidated". */
export function movesCursor(cls: ErrorClass): boolean {
  return cls === 'StateInvalid';
}

// ─────────────────────────────────────────────────────────────────────────────
// §7.2 Backoff
// ─────────────────────────────────────────────────────────────────────────────

export type BudgetMode = 'foreground' | 'background';

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS: Record<BudgetMode, number> = {
  foreground: 60_000,
  background: 15 * 60_000,
};

/** §7.2: max attempts per operation within a cycle, then the cycle ends `failed`. */
export const MAX_ATTEMPTS_PER_OP = 4;

/**
 * Full-jitter exponential: `delay = random(0, min(cap, base * 2^attempt))`.
 *
 * Jitter is not decoration here. §10 has multiple independent triggers, up to
 * five accounts, and a network-recovery trigger that fires for everything at once
 * — exactly the shape that produces a synchronised stampede against one Stalwart
 * instance. `random` is injectable so the tests can assert the bounds rather than
 * the draw.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { mode?: BudgetMode; retryAfterMs?: number; random?: () => number } = {},
): number {
  const mode = opts.mode ?? 'foreground';
  const cap = BACKOFF_CAP_MS[mode];
  const ceiling = Math.min(cap, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  const random = opts.random ?? Math.random;
  const jittered = Math.floor(random() * ceiling);
  // A Retry-After always overrides a SMALLER computed delay; it never shortens a
  // longer one, or a server asking for a minute could be hammered in a second.
  return Math.max(jittered, opts.retryAfterMs ?? 0);
}
