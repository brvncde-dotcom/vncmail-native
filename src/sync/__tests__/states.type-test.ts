// Type-level tests for §3.2's branded cursor provenance (design §13).
//
// These are NOT vitest tests — they are assertions checked by `npm run
// typecheck`, which is the point: a type-level test only earns its keep if a
// regression fails the build, so this file must live somewhere tsc compiles. It
// does (tsconfig has no `include`, so every .ts under the project is compiled),
// and `@ts-expect-error` is self-policing in both directions — tsc reports an
// unused directive if the error it guards ever stops happening, so a brand that
// silently loses its teeth fails the build just as loudly as a real type error.
//
// Each expect-error below was verified to be REAL by deleting the directive and
// confirming tsc rejects the line.

import {
  asChangesState,
  asSnapshotState,
  type ChangesState,
  type EnumerationCommitment,
  mintEnumerationCommitment,
  type SnapshotState,
} from '../states';
import type { CursorKey, SyncTxn } from '../store';

declare const txn: SyncTxn;
declare const key: CursorKey;

const changes: ChangesState = asChangesState('changes-token');
const snapshot: SnapshotState = asSnapshotState('snapshot-token');

// ─────────────────────────────────────────────────────────────────────────────
// (a) A SnapshotState cannot be passed where advanceCursor expects a
//     ChangesState. This is D4's exact shape — `email-store.ts:885-889` adopting
//     an `Email/get` `state` as the next `Email/changes` cursor — rejected at the
//     call site by the compiler rather than by a code comment.
// ─────────────────────────────────────────────────────────────────────────────

void txn.advanceCursor(key, changes); // the legitimate delta-path write

// @ts-expect-error — a Foo/get snapshot state is not a Foo/changes newState (D4).
void txn.advanceCursor(key, snapshot);

// @ts-expect-error — nor is a bare string; §12.1's wrappers return branded values.
void txn.advanceCursor(key, 'some-state-token');

// The two brands are mutually exclusive, not just distinct from `string`.
// @ts-expect-error — a ChangesState is not a SnapshotState either.
const _notInterchangeable: SnapshotState = changes;

// ─────────────────────────────────────────────────────────────────────────────
// (b) A plain object literal cannot satisfy EnumerationCommitment. V3's whole
//     point: revision 2 declared it as a plain interface and asserted in a
//     COMMENT that it was "only constructible by coverage/reconcile", which any
//     module could falsify with a literal — making the seed path's teeth strictly
//     weaker than advanceCursor's. The `unique symbol` tag is not exported, so
//     mintEnumerationCommitment is the only way to obtain the type.
// ─────────────────────────────────────────────────────────────────────────────

const commitment: EnumerationCommitment = mintEnumerationCommitment({
  jmapAccountId: 'acct-a',
  snapshot,
  targetFrom: '2026-07-01T00:00:00Z',
  sweepFloor: '2026-07-01T00:00:00Z',
  kind: 'bootstrap',
});

void txn.seedCursor(key, commitment); // the legitimate seed

// @ts-expect-error — an object literal with every visible field is still not an
// EnumerationCommitment: the tag is module-private, so there is no way to write it.
const _forged: EnumerationCommitment = {
  jmapAccountId: 'acct-a',
  snapshot,
  targetFrom: '2026-07-01T00:00:00Z',
  sweepFloor: '2026-07-01T00:00:00Z',
  kind: 'bootstrap',
};

// @ts-expect-error — and it cannot be smuggled straight into seedCursor either.
void txn.seedCursor(key, {
  jmapAccountId: 'acct-a',
  snapshot,
  targetFrom: '2026-07-01T00:00:00Z',
  sweepFloor: '2026-07-01T00:00:00Z',
  kind: 'bootstrap',
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) patchCursor cannot write `state`. §7.5 rule 1: the ONLY cursor-state writes
//     are advanceCursor and seedCursor, so a patch path that could set `state`
//     would be a third, unbranded way in.
// ─────────────────────────────────────────────────────────────────────────────

void txn.patchCursor(key, { drainPending: true, consecutiveFailures: 0 });

// @ts-expect-error — `state` is Omit-ed from the patch type.
void txn.patchCursor(key, { state: 'sneaky-token' });

export type { };
