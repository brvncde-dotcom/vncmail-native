// Cursor provenance, with type-level teeth (design §3.2).
//
// The invariant these types enforce is I2, and it is an ORDERING rule, not a
// source rule: a cursor advances to a `Foo/changes` `newState`, and may be
// *seeded* from a `Foo/get` `state` only inside an `EnumerationCommitment` whose
// enumeration starts after that snapshot was captured. Revision 1's stricter
// "only a changes state, ever" was false — bootstrap (§4.1) and reconcile (§7.6)
// both legitimately seed from a snapshot — and a rule the design itself violates
// is a rule that gets bypassed at the one call site that matters, which is
// exactly the shape of shipped defect D4.

/** Local account identity: `username@host`, from lib/account-utils generateAccountId(). */
export type LocalAccountId = string;

/** JMAP-level account id from the session (primaryAccounts[mail], or a shared/group account). */
export type JmapAccountId = string;

/** Types we hold a /changes cursor for. NOT a list of push types. */
export type CursorType = 'Email' | 'Mailbox';

/** From a `Foo/changes` response's `newState`. The only value the delta path may advance to. */
export type ChangesState = string & { readonly __brand: 'ChangesState' };

/** From a `Foo/get` response's `state`. A valid cursor ONLY under the ordering rule above. */
export type SnapshotState = string & { readonly __brand: 'SnapshotState' };

// ── The only two ways to mint a branded state ──
//
// These exist so that no `as ChangesState` / `as SnapshotState` cast is needed
// anywhere, which in turn makes "no such cast exists" a greppable, testable
// assertion (§6.3, §13). Per §12.1 the ONLY legitimate callers are the response
// parsers in `src/api/email.ts`; calling them anywhere else re-opens D4 by hand.

/**
 * L4: the brand certifies PROVENANCE, but a JMAP response body is parsed JSON, so the
 * value could be a number, null or an object and the cast would happily launder it into
 * something the rest of the engine treats as a cursor. Check the shape too — a
 * malformed state token must fail loudly at the boundary rather than being persisted
 * and compared for the lifetime of the account.
 */
function certifyStateToken(value: unknown, kind: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `${kind}: expected a non-empty string state token, got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value;
}

/** For `src/api/email.ts` response parsers only. */
export function asChangesState(newState: unknown): ChangesState {
  return certifyStateToken(newState, 'ChangesState') as ChangesState;
}

/** For `src/api/email.ts` response parsers only. */
export function asSnapshotState(state: unknown): SnapshotState {
  return certifyStateToken(state, 'SnapshotState') as SnapshotState;
}

// ── EnumerationCommitment ──
//
// V3: the tag is a module-private `unique symbol`. It is NOT exported, so no
// object literal anywhere in the codebase can produce this type and
// `mintEnumerationCommitment` is the only way to obtain one. Revision 2 declared
// this as a plain interface and asserted constructibility in a comment, which
// any module could falsify with a literal — making the seed path's teeth
// strictly weaker than `advanceCursor`'s.
//
// Correction to §3.2's sketch: the design writes `declare const
// enumerationCommitmentTag: unique symbol`, which declares a type-level name with
// NO runtime value — so `mintEnumerationCommitment` cannot use it as a computed
// key and throws `ReferenceError: enumerationCommitmentTag is not defined` the
// first time it runs. (The contract tests caught this.) A real, unexported
// `Symbol()` gives the same `unique symbol` type, keeps the tag unnameable
// outside this module, and — unlike `declare const` plus an `as
// EnumerationCommitment` cast to satisfy the compiler — needs no cast at all,
// which is what §6.3 asks for.
const enumerationCommitmentTag = Symbol('EnumerationCommitment');

export interface EnumerationCommitment {
  readonly [enumerationCommitmentTag]: true;
  readonly jmapAccountId: JmapAccountId;
  readonly snapshot: SnapshotState;
  /** The retention floor the enumeration is working toward. */
  readonly targetFrom: string;
  /**
   * The floor PINNED for this enumeration (S2). Equal to `targetFrom` for a
   * bootstrap; for a reconcile it is the floor captured at step 0, and the
   * sweep deletes only against this value, never a `targetFrom` that moved
   * while the reconcile was running.
   */
  readonly sweepFloor: string;
  /** Which job minted it. */
  readonly kind: 'bootstrap' | 'reconcile';
}

/**
 * The only constructor for an `EnumerationCommitment`.
 *
 * Deviation from §3.2, noted deliberately: the design asks for this factory to
 * live in `coverage.ts` / `reconcile.ts` "so the mint site and the enumeration
 * that justifies it live in the same module". Those modules are Stage C and do
 * not exist yet, and the unforgeability property requires the tag to stay
 * unexported — so exporting the tag for a future module to use would defeat the
 * whole mechanism V3 exists to install. The load-bearing property (a single
 * mint site, unforgeable by literal) holds here; when `coverage.ts` lands, the
 * tag and this function move there together and nothing else changes.
 */
export function mintEnumerationCommitment(args: {
  jmapAccountId: JmapAccountId;
  snapshot: SnapshotState;
  targetFrom: string;
  sweepFloor: string;
  kind: 'bootstrap' | 'reconcile';
}): EnumerationCommitment {
  return {
    [enumerationCommitmentTag]: true,
    jmapAccountId: args.jmapAccountId,
    snapshot: args.snapshot,
    targetFrom: args.targetFrom,
    sweepFloor: args.sweepFloor,
    kind: args.kind,
  };
}

/**
 * The coverage phase a seed implies (§4.1 step 1, §7.6 step 1). Bootstrap seeds
 * a scan; reconcile seeds a rebuild whose sweep is gated on completion.
 */
export function coveragePhaseForCommitment(
  commitment: EnumerationCommitment,
): 'scanning' | 'reconciling' {
  return commitment.kind === 'bootstrap' ? 'scanning' : 'reconciling';
}
