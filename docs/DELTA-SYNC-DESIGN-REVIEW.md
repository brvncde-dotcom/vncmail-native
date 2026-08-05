# Adversarial review of DELTA-SYNC-ENGINE-DESIGN.md

Reviewer: independent agent, fresh context, no relation to the design's author. 2026-08-04.

## Verdict

**Sound with specific required fixes — do not start implementing §7.6, §7.7, §9.2 or §9.3 as
written.**

The architecture is genuinely good and the reviewer could not break its core: cursor-last (I1),
capture-cursors-before-enumerate (§4.1), keyset-ascending backfill (§6.1), the three-machine
split, and "failure means the cursor stands still" are all correct, and the RFC reading behind
the 3-property `updated` fetch is right. That's the load-bearing 80%.

But there are five places (S1-S5 below) where the document's *stated* safety property does not
follow from its *own* mechanisms, each producing silent data loss or corruption rather than a
visible bug. All are localized fixes, no re-architecture. Two are triggered specifically by the
two decisions the human made after the design was written (envelope retention widened well
beyond body retention; offline caching stays default-off).

---

## Part 1 — Defect citation audit (D1-D8)

Every file:line cited resolves and every quoted comment is verbatim. Two characterizations need
correcting before they're used as bug-fix task descriptions:

- **D4** — claim (a) ("adopting an Email/get state silently skips changes just applied") is
  **not reachable** — `nextEmailState ?? fetchState ?? emailState` short-circuits once a changes
  page is applied. The **real** bug is claim (b): `getEmailChanges` returning `null` for *any*
  error (D5) causes `fetchState` (an `Email/get` state captured *this cycle*) to be adopted as
  the new Email cursor, with no resync — so a transient 503 on `Email/changes` fast-forwards the
  cursor over every unseen change. (b) alone justifies the original severity; fix the citation
  wording, not the severity.
- **D6** — understated, not overstated. It's not "downloads account B's mail and throws it
  away" — `setAccount()`'s abort flag is only checked at chunk boundaries (after up to 25 full
  bodies already fetched), and `put()` reads `activeAccountId` fresh at write time. Net effect:
  **account A's messages get written under account B's storage key/index** — actual persisted
  cross-account contamination, not wasted bandwidth. This is the single worst bug currently
  shipped; raise its severity.
- **D3** — real, but overstated: the common case (a populated Inbox) is bounded by an
  early-break at the index scan; the actual unbounded cost is the *sparse/empty-folder* case.
  Also: **the design does not actually close D3 in v1** (see S4 below) — remove the "closed by
  §9.3" claim or bring the SQLite backend forward.

D1, D2, D5, D7, D8 all confirmed exactly as described, D2 understated (the same
fire-and-forget/silently-caught-error pattern recurs in `put()`, `patch()`, `remove()`,
`clearAll()`, not just `persistIndex` — scope the fix to the whole store).

All RFC 8620/8621 claims checked out except one (S14 below).

---

## Part 2 — Findings requiring fixes before implementation, ranked

### S1 (CRITICAL) — `AccountSyncState` has no read-modify-write discipline

The AsyncStorage backend commits cursor+coverage+flags as **one whole-struct blob**, loaded at
cycle start. If a concurrent action (e.g. `clearRecords()` from a Settings "clear cache" tap)
mutates a *different* field of that same struct while a cycle is mid-flight, the cycle's
end-of-cycle commit overwrites it with a stale copy — reviving `resyncRequired: false` right
after it was set true. Concrete result: an **empty record store with a live, advanced cursor and
no resync pending** — permanent silent data gap, exactly the state the design's own §8.1 says
must never happen. Compounding: `epoch` (the guard meant to prevent exactly this) has no
authoritative owner specified and no write path from `SyncTxn` at all.

**Fix:** `SyncTxn` must expose only field-level patches to `AccountSyncState`, never a
whole-struct write; the AsyncStorage backend must re-read-merge-write under a per-account mutex;
name the epoch's single source of truth explicitly; add `clearRecords` and feature-disable to the
epoch-bump list.

### S2 (CRITICAL) — retention-window race deletes mail permanently

`reconcile()` doesn't pin `targetFrom` for its own duration. If the user widens the retention
window *while* a reconcile is running (very plausible — the reconcile UI banner is exactly what
prompts someone to go change the setting), step 4's delete sweep runs against the *new* (wider)
window while step 3 only ever enumerated the *old* (narrower) window — deleting every record in
the gap, permanently, since `coveredFrom` is then set to the new, wider floor and delta sync
cannot re-deliver pre-existing mail.

**Fix:** snapshot `targetFrom` into `CoverageState` at reconcile start, sweep against the
snapshot only; a retention change during a reconcile must defer or force `phase` back to
`'scanning'` *after* the sweep completes.

### S3 (HIGH) — SQL schema assumes globally-unique JMAP ids; they're only unique per-account

None of the three primary keys (`mailbox.id`, `envelope.id`, `email_mailbox`) include the JMAP
account id, even though the codebase already knows ids collide across accounts (existing
prefixing workaround in `email.ts:19-20`). Once shared/group accounts land (§8.2), two accounts'
mailboxes sharing an id will silently merge rows — cross-account leakage inside a design whose
entire §8 is about isolation. Also falsifies §8.2's claim that adding multi-account support later
is "inserting rows, not migrating."

**Fix:** every relevant PK/FK becomes `(jmap_account_id, id)` now — costs nothing today,
unfixable without a real migration later.

### S4 (HIGH) — D3 is not actually closed in v1

§1.3 claims D3 (unbounded folder-open scan) is closed by the SQLite schema in §9.3 — but §9.3 is
explicitly "step 6 shape," while the AsyncStorage backend ships first (§14.3). The AsyncStorage
backend has no way to implement an indexed `queryEnvelopes` without either (a) the same O(cache)
scan as today (D3 ships unfixed), or (b) rewriting a full membership index blob on every page
commit (a real availability problem once envelope retention is widened per the human's decision).

**Fix:** either remove the "closed by" claim for v1, or reorder §14.3 so `expo-sqlite` ships
*before* the sync engine (also closes S1's atomicity gap for free, since the boundary exists
precisely to make this reordering cheap).

### S5 (HIGH) — the "only a changes.newState may become a cursor" rule is false as stated, and unenforced

The design's own bootstrap (§4.1) and reconcile (§7.6) *correctly* seed cursors from a
`Foo/get {ids: []}` state — which is a legitimate cursor per RFC 8620, contradicting the
document's own I2 as literally written. The real invariant is about *ordering*, not *source*: a
`get` state may become a cursor only when a full enumeration that starts after it is about to
rebuild the record set it describes. As written, an implementer who takes I2 literally (and the
design's own §13 test plan describes exactly that literal test) will have to special-case bypass
it for bootstrap/reconcile — precisely how such a rule gets silently violated at the one call
site that matters (D4(b)).

**Fix:** restate I2 as the ordering rule; give it structural teeth (a branded type distinguishing
a `Foo/changes` state from a `Foo/get` state, with only the delta path's cursor-write function
accepting the branded changes-state type).

### S6 (HIGH) — per-account failure counters guard per-cursor state machines

`consecutiveFailures`/`lastFailedState` (the anti-wedge escalation ladder, I10) live as scalars on
`AccountSyncState`, but cursors are keyed per-type (Mailbox vs Email). If Mailbox drains fine
every cycle while Email fails every cycle, a plausible cycle-outcome mapping resets the shared
counter to 0 each time (since *something* succeeded) — the ladder never escalates, and the Email
cursor never advances again, silently, forever. This is the exact wedge I10 exists to make
unreachable.

**Fix:** move failure counters onto `SyncCursor` (per cursor-type), not `AccountSyncState`;
define explicitly that a cycle is `'failed'` for escalation purposes if *any* machine failed,
regardless of what the others achieved.

### S7 (medium-high) — the maxChanges retry ladder gets larger on its third attempt, not smaller

Attempt 3 removes the `maxChanges` bound entirely, justified by a claimed RFC ambiguity the
reviewer could not substantiate against RFC 8620 §5.2. This actively worsens the likely real
cause of a bounded-call failure (response too large) by making the retry strictly larger.

**Fix:** make the ladder monotonically smaller (e.g. 500 → 250 → 50 → 25); drop the unbounded
rung.

### S8 (medium-high) — a `partial` cycle has no dedicated resume trigger

A large pending backlog can stall indefinitely: nothing re-triggers a sync purely because the
previous cycle was `partial`, other than app relaunch. A user who stays foregrounded reading mail
after enabling the feature with a big backlog may never get another cycle.

**Fix:** add a trigger — "previous cycle returned partial or any cursor has drainPending" →
reschedule shortly after.

### S9 (medium-high, directly affects the human's envelope-retention decision) — no body-backfill job

The schema supports independent envelope/body retention tiers; the job set does not. Bodies are
only ever enqueued at `Email/changes`-created time or during the initial coverage scan — there is
no job that later backfills bodies for envelopes already covered but outside the (narrower) body
window when the user widens the body window after coverage has already completed. Concrete
result: widening the body-retention setting silently does nothing for already-covered envelopes.

**Fix:** add a body-backfill pass using the schema's own already-defined
`queryEnvelopes({hasBody: false})` primitive; split the retention-change failure-mode rows into
four (envelope-widen / envelope-narrow / body-widen / body-narrow) instead of one.

Related: with envelope retention now widened significantly (per the human's decision), a
reconcile enumerating the *whole* envelope window fully blocks delta sync for its entire
multi-cycle duration under the current wording — narrow that prohibition to just the invalidated
cursor, going live immediately after the reconcile's fresh-cursor capture step, gating only the
final sweep on enumeration completing.

### S10 (medium) — `oldState` mismatch escalates to full reconcile unconditionally, no loop breaker

If a server ever echoes a non-byte-identical but semantically-equal `oldState`, every single
cycle would trip the mismatch, reconcile, capture a fresh cursor, and trip again next cycle —
unbounded full-window rescans, and `consecutiveFailures` never catches it because each reconcile
"succeeds."

**Fix:** re-issue once and compare before escalating; add a reconciles-per-day ceiling with a
loud log.

### S11 (medium) — local-mutation overlay is unowned and non-atomic

No component is named as responsible for writing optimistic local mutations (e.g. "mark read"
while offline) into the new durable store, and the outbox-overlay mechanism isn't specified as
atomic with the record write it's supposed to patch — a reachable sequence loses a local mutation
silently until the next app restart.

**Fix:** name the write-through owner explicitly (outbox enqueue → same transaction as the record
write); make the overlay a pure function parameter, not a store read from inside `apply()`.

### S12 (medium) — three unspecified paths create orphan body rows that leak against the storage cap

Unclear behavior for: whether `clearRecords()` also clears the body queue; no `notFound` handling
in the coverage-triggered body fetch (job C); undefined re-enqueue semantics (does it reset the
retry-attempts counter, defeating the give-up-after-5 rule). Each leaks bytes that count against
the user's storage cap but are invisible to eviction.

**Fix:** `clearRecords()` explicitly clears the body queue; job C dequeues immediately on
`notFound`; re-enqueue is insert-or-ignore and never resets the attempts counter; add
`received_at` to the body table so eviction can't be blinded by a missing join.

### S13 (medium, directly affects the human's cache-default decision) — disabling the feature isn't a defined abort/cleanup path

Toggling offline caching off mid-cycle is not on the document's list of cycle-abort triggers, so
an in-flight cycle keeps writing to disk after the user opted out. Also: reads that seed the
in-memory list from the offline store run unconditionally regardless of the setting, meaning even
users who never enable the feature may end up with a per-account encrypted database file
materialized (once step 6's SQLCipher lands) purely from that read path.

**Fix:** add feature-disable to the abort-trigger list and to the epoch-bump list; add an
explicit rule that the store opens lazily and never materializes a backing file/key for a
disabled account; decide whether disabling also purges (recommended once encrypted).

### S14 (medium, RFC accuracy) — `after` filter boundary is specified, not implementation-defined

RFC 8621 §4.4.1 defines `after` as inclusive on all conforming servers — the design's hedge
("exclusive in some implementations") is incorrect and its suggested +1ms mitigation would, if
ever applied as the default path rather than the rare-tie-cluster fallback, silently skip
messages sharing the boundary millisecond on any conforming server.

**Fix:** state the spec as ground truth (inclusive); keep the tie-cluster anchor-guard fallback
but gate the +1ms rung behind a logged warning and a recorded gap marker, never as normal-path
behavior.

### S15 (low-medium) — no rule for a corrupt (vs. merely absent) `AccountSyncState` blob

An unparseable blob should force `resyncRequired = true` (or purge outright), not silently fall
back to empty cursors with a store full of unverified pre-existing records that then never get
swept.

### S16 (low) — smaller items, fix opportunistically

- The `integration/` Stalwart fixture referenced for testing lives in the *sibling*
  `vncmail-plus` repo, not this one — "reuse it" implies real cross-repo CI cost, not a free
  reuse.
- `vncmail:sync:registry` stores plaintext `username@host` per account outside the encrypted
  store — acceptable (an unencrypted index is needed to know what to purge) but should be stated
  as an accepted limitation, or moved into `expo-secure-store`.
- Device clock skew during a reconcile can delete then re-download the whole store — bounded and
  self-correcting, but "no correctness impact" is too strong a claim for a feature whose purpose
  is having mail while offline.
- §5.1's cycle ordering (Mailbox → Email → Bodies) should state its own justification (destroy
  processed before coverage can resurrect it) rather than leaving it implied by a trigger table
  elsewhere.
- F26 (as written) implies fabricating a `receivedAt` for an `updated` id we don't hold, which
  the schema's `NOT NULL` constraint and the actual 3-property fetch shape can't support — restate
  as an unconditional no-op when the record is absent.

---

## Part 3 — Hidden couplings between the three state machines

The three-machine separation is cleaner than expected. It depends entirely on **single-flight
execution within an account** (Mailbox → Email → Bodies, sequential, never concurrent) — the
design should say this explicitly rather than presenting the three machines as fully independent,
since a future "run bodies in parallel, it's separate state" optimization would immediately
produce orphan bodies. The couplings actually missed by the "three independent machines" framing
are S1 (one shared persistence blob) and S6 (shared failure counters) — both in the persistence
layer, not the logical model.

## Part 4 — `android/` vs. Continuous Native Generation

Confirms and sharpens the earlier flag: this isn't just "sits uneasily" — `android/` contains 8
hand-written Kotlin files (FCM push modules, a client-cert module, notification tap storage) that
no Expo config plugin currently generates, plus `google-services.json` and a debug keystore.
`expo prebuild --clean` (needed to apply step 6's `useSQLCipher` plugin) would destroy all of it.
This is a real program-level conflict with the earlier CNG decision, already broken by earlier
native-push work — not something this design doc creates, but something it will collide with at
step 6. Two options for a human decision when that point arrives: port the Kotlin modules into a
local Expo config plugin (restores real CNG), or formally abandon CNG for Android and accept
hand-maintained native there (which also incidentally resolves S4).

## Part 5 — What survived unbroken

§4.1's capture-before-enumerate ordering, §6.2's rejection of position-based paging, §6.1's
ascending keyset direction, the cursor-last invariant's two crash walk-throughs, the 3-property
`updated`-fetch rule and its RFC basis, create/update/destroy-within-a-page ordering, the
no-inferred-deletion rule (I7), the error taxonomy defaulting to transient, "offline is not an
error," "a pushed StateChange value is never a cursor," the headless-execution constraint, the
pure-`apply.ts` requirement, and "discard and rebuild, don't migrate" for existing local caches on
first launch of the new engine. All RFC claims checked out except S14.
