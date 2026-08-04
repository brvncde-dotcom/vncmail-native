# JMAP Delta-Sync Engine — Design

Status: **design only, not implemented. Revision 2**, after independent adversarial review.
Produced for `VNCprodbuild` Phase 2 step 5 (`[AI, L]`). Nothing in `src/` has been changed by
either pass.

- Revision 1: 2026-08-04, commit `dc222e8`.
- Adversarial review: `docs/DELTA-SYNC-DESIGN-REVIEW.md`, commit `987f874` — verdict *"sound with
  specific required fixes; do not implement §7.6, §7.7, §9.2 or §9.3 as written"*, 16 findings.
- Revision 2: 2026-08-04, commit `6a2fde7` — every finding S1–S16 addressed; §0.1 maps each to where.
- Targeted verification pass on revision 2: four line-level gaps (V1–V4). **Revision 3 is this
  document**; §0.2 maps those four.

Repo: `brvncde-dotcom/vncmail-native`, branch `claude/delta-sync-design`, worktree
`~/worktrees/vncmail-native-delta-sync`.

Companion documents:
- `~/.claude/skills/VNCprodbuild/SKILL.md` — the build plan; this is step 5 of Phase 2.
- `~/worktrees/vncmail-electron/docs/VNCMAIL-NATIVE-BUILD-MANUAL.md` — program narrative;
  §4 decision log, §6.1 (what this repo already has), §7 (remaining roadmap).
- `docs/DELTA-SYNC-DESIGN-REVIEW.md` — the review this revision answers.

Normative references, cited by section throughout:
- **RFC 8620** (JMAP core) — §1.2 ids, §3.6.1 request-level errors, §3.6.2 method-level errors,
  §5.1 `Foo/get`, §5.2 `Foo/changes`, §5.5 `Foo/query` (incl. `anchor`), §7.1 `StateChange`.
- **RFC 8621** (JMAP Mail) — §2.2 `Mailbox/changes` (incl. `updatedProperties`), §4.1 Email
  property mutability, §4.2 `Email/get`, §4.3 `Email/changes`, §4.4.1 `Email/query`
  `FilterCondition`, §4.5 `Email/queryChanges`.

---

## 0. Scope

**In scope (this design):** the mechanism that keeps a per-account local mail store in step with
the server using `Email/changes` and `Mailbox/changes` — first-sync bootstrap, change application,
pagination, crash recovery, error/retry semantics, multi-account isolation, the storage
abstraction boundary, and triggering.

**Out of scope, deliberately:**
- SQLCipher key derivation/lifecycle (skill step 7, human-gated). §14 now sequences *plain*
  `expo-sqlite` ahead of the engine (S4); enabling `useSQLCipher` remains a later, separate step.
- FTS5 index population (step 9) — §9.4 reserves the hook.
- Offline compose/outbox *transport* (step 10). The existing `src/stores/outbox-store.ts` is
  reused; §5.6 defines the (revised) interaction and §12.3 the one change it needs.
- Background task registration (`BGTaskScheduler`/`WorkManager`). §10.5 defines the constraint so
  that step is wiring only.
- Calendar/Contacts/Files delta sync.
- Shared/group (Stalwart "group account") mail. Account-scoped keys are in place from day one
  (S3) so adding it later is inserting rows.

**Non-goal:** compatibility with today's cache. §14.1 specifies discard-and-rebuild.

### 0.1 How revision 2 answers the review

| # | Finding | Addressed in |
|---|---|---|
| **D4** | citation wording wrong; severity stands | §1.3 D4, rewritten |
| **D6** | understated — actual persisted cross-account contamination | §1.3 D6, severity raised |
| **D3** | overstated, and not closed in v1 | §1.3 D3, softened; "closed by" claim removed; §14.3 reordered |
| **D2** | scope wider than `persistIndex` | §1.3 D2, scope broadened |
| **S1** | whole-blob `AccountSyncState` write ⇒ lost update | §3.1, §3.4 I12, §9.1 (field-level `SyncTxn` patches, per-account mutex), §8.3 (epoch owner), F37 |
| **S2** | reconcile doesn't pin `targetFrom` ⇒ permanent deletion | §3.1 `sweepFloor`, §7.6 step 0/4, F38 |
| **S3** | JMAP ids are per-account, not global | §9.3 (account-scoped PKs), §8.2 (overclaim retracted) |
| **S4** | D3 not closed in v1 | §9.2 (SQLite is the shipping backend), §14.3 (reordered), §1.3 D3 |
| **S5** | I2 false as stated, and unenforced | §3.2 branded state types, §3.4 I2 restated as ordering, §7.5, §9.1 `advanceCursor`/`seedCursor`, §13 |
| **S6** | per-account failure counters guard per-cursor machines | §3.1 (counters on `SyncCursor`), §7.7, F47 |
| **S7** | `maxChanges` ladder grows on attempt 3 | §7.7 (monotonic 500→250→50→25; unbounded rung dropped, unsubstantiated RFC claim retracted) |
| **S8** | `partial` cycle has no resume trigger | §10.1 T9, §10.3 chaining rule, F46 |
| **S9** | no body-backfill job; reconcile blocks delta too long | §2 job C2, §7.6 (delta live immediately, only sweep gated), F23–F24B, F49 |
| **S10** | `oldState` mismatch can loop | §7.6.1 (re-issue once, reconcile ceiling), F39 |
| **S11** | local-mutation overlay unowned/non-atomic | §5.6 rewritten — read-time overlay, no write-through, atomicity problem deleted; §12.3 |
| **S12** | orphan body rows leak against the cap | §9.1, §9.3 (`received_at` on `body`), §7.4, F40/F41/F45 |
| **S13** | feature-disable isn't an abort/cleanup path | §10.1 T10, §8.3, §8.4 (purge-on-disable), §9.5 (lazy open), F42 |
| **S14** | `after` is spec-defined inclusive | §6.1 corrected, +1 ms rung gated, F33 |
| **S15** | no rule for a corrupt state blob | §3.4 I13, F43 |
| **S16** | six smaller items | §13 (cross-repo fixture), §8.1 (registry plaintext), §3.4 I8 + F44 (clock), §5.1 (ordering justification), §5.3/F26 (absent-id no-op), §2 I11 |
| Part 3 | three machines share single-flight, not fully independent | §2, §3.4 I11, F48 |
| Part 4 | `android/` vs CNG | §16 — flagged as a program-level decision, deliberately not resolved here |

**Disagreements: none.** Every S1–S16 finding is accepted. Two are implemented differently from
the review's suggested fix, in both cases by removing the failure mode rather than guarding it —
S11 (read-time overlay instead of an atomic write-through) and S7's third rung (dropped rather
than reordered). Both are noted inline and in §15's closing note.

### 0.2 How revision 3 answers the verification pass

| # | Gap | Addressed in |
|---|---|---|
| **V1** | Revision 2 made the outbox the *sole* durable record of local intent, then asserted a durability it does not have: `persist()` (`outbox-store.ts:69-73`) is fire-and-forget and `enqueue` (`:62`, `:166-167`) returns before the write lands, so `applyOrQueueBatch` reports `{queued: true}` (`:290-292`) with nothing on disk. §12.3's "no persistence change needed" was wrong. Two overlay read-path claims were also wrong: badge counts cannot be corrected by an email-record overlay, and the call-site list missed `getEmailDetail`. | §5.6 (durability requirement + retracted badge claim), §12.3 (outbox change is now required; `getEmailDetail` added), §13 |
| **V2** | Only rung 0 of the `maxChanges` ladder was clamped by `min(maxObjectsInGet, 500)`; rungs 1–3 were bare constants, so a server advertising `maxObjectsInGet < 250` makes the *first retry larger than the attempt that just failed* — S7's defect in a narrower form. Also unstated whether reconcile resets the escalation counters. | §7.7 (rungs relative to rung 0), §7.6 step 5 (counters reset, stated) |
| **V3** | `EnumerationCommitment` was a plain interface, so "only constructible by coverage/reconcile" was a comment, not a compile-time guarantee — unlike the properly-branded `ChangesState`/`SnapshotState`. §6.3's pseudocode also modelled an `as ChangesState` cast, i.e. the exact escape hatch that defeats a brand. | §3.2 (branded + factory-only construction), §6.3 (cast removed), §13 (type-level test) |
| **V4** | S4's reorder rests on "plain `expo-sqlite` works in Expo Go", which is plausible but untested — `expo-sqlite` is not yet a dependency of this repo. And `purgeAccount`'s reason enum had no case for the encryption flip, whose trigger (`schemaVersion`) lives *inside* the file that the flip makes unreadable. | §9.2 + §14.3 (caveat, flagged as verify-first), §8.4 (`store-format-change` reason + out-of-band format marker), §9.1 (`SyncStoreFactory` marker methods) |

**V1–V4 are all accepted.** One factual correction to the report itself: the single-message offline
fallback is `getEmailDetail` (`email-store.ts:1034-1056`, cached read at `:1053`), not
`loadFullEmail`; the gap it identifies is real either way. The badge-count claim is retracted rather
than implemented, per the report's own recommendation — reasoning in §5.6.

---

## 1. What exists today, verified

File:line references are to this worktree at commit `987f874`.

### 1.1 The thing being replaced

`src/lib/offline-sync.ts` (155 lines) — `runOfflineSync({days, maxMB})`:

1. `Email/query` filtered by `{ after: now - days }`, one call, `limit = DISCOVERY_LIMIT`
   (5000, `offline-sync.ts:25`), no paging, no mailbox filter.
2. Everything not already cached is fetched with `getFullEmails()` in chunks of
   `min(25, maxObjectsInGet)` — full bodies, `maxBodyValueBytes: 512000`.
3. Ids in the cache but absent from the query result are removed (`offline-sync.ts:67-71`).
4. `evictToFit(maxMB)` sheds oldest-by-`receivedAt` at the end.

`src/stores/offline-cache-store.ts` (322 lines) — Zustand + AsyncStorage. Per-account key
prefixes (`webmail:offline-cache:index:v2:<accountId>`, `…:entry:v2:<accountId>:<emailId>`),
an in-memory index of `{id, receivedAt, size, cachedAt}`, and the `SyncState` the UI reads.

UI: `src/components/OfflineCacheBanner.tsx`, `src/components/settings/AboutDataSettings.tsx`.
Triggers: `App.tsx:277-284`. Settings: `offlineCacheEnabled/Days/MaxMB`
(`settings-store.ts:222-226`, defaults `false / 7 / 50`).

### 1.2 What already exists and should be reused

The repo is further along than the manual implies. `src/api/email.ts` already has `/changes`
wrappers, and `src/stores/email-store.ts` already drives an incremental path for the *visible
list*:

| Existing | Location |
|---|---|
| `Email/changes` wrapper | `src/api/email.ts:357-376` (`getEmailChanges`) |
| `Mailbox/changes` wrapper | `src/api/email.ts:136-154` (`getMailboxChanges`) |
| `Email/queryChanges` wrapper | `src/api/email.ts:277-311` |
| `Email/get` + `state` token | `src/api/email.ts:324-344` (`getEmailsWithState`) |
| Per-JMAP-account Email state map | `email-store.ts:101-121` (`stateKey`, `withEmailState`) |
| `Mailbox/changes` drain incl. `hasMoreChanges` | `email-store.ts:538-602` |
| Account-switch race guards | `email-store.ts:131-138` (`jmapClientServesActiveAccount`) |
| SSE `StateChange` → refresh | `src/api/push.ts:120-157`, `email-store.ts:969-1003` |
| Idempotent full-state mutation queue | `src/stores/outbox-store.ts` |
| Cross-account id-collision workaround | `src/api/email.ts:19-20` (`sharedMailboxId`) — the existing evidence for S3 |

The engine is **not** a replacement for the email-store's list-level `queryChanges` path — that
path keeps *one visible mailbox window* fresh and is correct for that job. The engine owns the
*durable local store*. §5.7 defines the boundary.

### 1.3 Defects in the existing code (must not be inherited)

Severities and wordings below incorporate the review's Part 1 audit.

- **D1 — cached envelopes go permanently stale.** `offline-sync.ts:77` skips any id already in the
  index, with the comment "bodies on disk are immutable per messageId". Bodies are indeed
  immutable (RFC 8621 §4.1), but `keywords` and `mailboxIds` are the two mutable properties and
  live in the same blob. A message cached while unread stays unread in the offline list forever
  unless the user opens it online (`email-store.ts:1044-1050`) or a local mutation patches it
  (`offline-cache-store.ts:210-223`). *Closed by §5.3.*
- **D2 — storage write failures are swallowed, store-wide.** Not just `persistIndex()`
  (`offline-cache-store.ts:97-101`): the same fire-and-forget / silently-caught pattern recurs in
  `put()` (`:187-191`), `patch()` (`:214-222`), `remove()` (`:229-231`) and `clearAll()`
  (`:266-268`). A failed write leaves unreferenced blobs (leak) or an index that disagrees with
  disk. In a cursor-carrying engine it would let a cursor advance over data never durably
  written. **Scope the eventual fix to the whole store, not one function.** *Closed by I4 and
  §9.2.*
- **D3 — sparse-folder reads are unbounded (narrower than revision 1 claimed).**
  `getEmailsInMailbox()` (`offline-cache-store.ts:275-301`) sorts the index by `receivedAt` and
  breaks at `limit`, so a *populated* folder is bounded. The unbounded case is the
  **sparse-or-empty folder**: it reads and JSON-parses every cached entry to find few or no
  matches. At the 50 MB cap that is thousands of AsyncStorage reads on the offline path.
  **Revision 1's "closed by §9.3" claim is withdrawn** — §9.3 is the SQLite schema, and revision 1
  shipped the AsyncStorage backend first, so D3 would have shipped unfixed. *Closed by §9.3 only
  under §14.3's revised sequencing (SQLite before the engine); if that sequencing is rejected, D3
  ships unfixed and §9.2's contingency applies.*
- **D4 — a transient error on `Email/changes` fast-forwards the cursor with no resync.**
  Revision 1 stated two claims; the first was wrong and is withdrawn. `email-store.ts:885-889`
  writes `nextEmailState ?? fetchState ?? emailState`, and `nextEmailState` is set to
  `ec.newState` whenever a changes page was applied (`:830`) — so a successfully-applied page
  short-circuits the fallback and an `Email/get` state is **not** adopted in that case. The real
  bug is the other path: because `getEmailChanges` returns `null` for *any* error (D5), a
  transient 503 or a rate-limit sets `nextEmailState = undefined` (`:834`), and the code then
  adopts `fetchState` — an `Email/get` `state` captured *this cycle* (`:849-851`) — as the new
  Email cursor, **with no resync**. Every change between the old cursor and that snapshot is
  skipped, permanently and silently. Severity unchanged; it is a live bug in shipped code.
  *Closed by I2 (as restated in §3.4) and §7.5.*
- **D5 — all method-level errors collapse to `null`.** `getEmailChanges` (`email.ts:366-367`) and
  `getMailboxChanges` (`email.ts:144-145`) return `null` for any `error` response, so
  `cannotCalculateChanges` (→ resync mandated), `serverUnavailable` (→ retry), rate limiting
  (→ back off) and `invalidArguments` (→ our bug) are indistinguishable. This is also the trigger
  for D4. *Closed by §12.1.*
- **D6 — persisted cross-account contamination (severity raised).** Revision 1 described this as
  wasted bandwidth; it is worse. `runOfflineSync` checks the abort flag only at *chunk* boundaries
  (`offline-sync.ts:100`), after up to 25 full bodies have already been fetched, and
  `offline-cache-store.put()` reads `activeAccountId` **fresh at write time** (`:184`), not from
  the value the fetch was issued under. So if `setAccount(B)` lands between a chunk's
  `getFullEmails()` resolving and its `put()` calls, **account A's messages are written under
  account B's entry keys and stamped into account B's index** — the post-await re-check (`:195`)
  only guards a switch *during* the write, not before it. This is actual persisted cross-account
  leakage and, on the reviewer's assessment, the worst bug currently shipped. *Closed by I6 and
  §8.3.*
- **D7 — "sync again" cancels instead of syncing.** `offline-sync.ts:41-44`: a call while a run is
  in flight sets the abort flag and returns. Tapping "Sync now" during a sync yields a *cancelled*
  sync and no new one. *Closed by §10.3.*
- **D8 — unstable pagination is latent.** No paging today (one 5000-id query), so the bug can't
  fire — but the obvious fix ("add `position`") would introduce it. See §6.2.

---

## 2. Architecture

Three state machines per account — **logically** independent (separate persisted state, separate
failure handling, separate budgets), **operationally** serialised (§3.4 I11). The review's Part 3
is right that presenting them as fully independent invites a future "run bodies in parallel, it's
separate state" optimisation that would immediately produce orphan bodies, so the coupling is now
stated as an invariant rather than left implied.

```
                         ┌───────────────────────────────┐
   triggers (§10) ──────▶│  SyncEngine.runCycle(account) │
                         └───────────────┬───────────────┘
                                         │ single-flight per account,
                                         │ jobs run SEQUENTIALLY (I11)
   ┌────────────┬──────────────┬─────────┴───────┬─────────────────┐
   ▼            ▼              ▼                 ▼                 ▼
 A1. Mailbox  A2. Email     B. COVERAGE       C1. bodies       C2. body
 /changes     /changes      envelope backfill  queue drain      backfill
 cursor       cursor        coverage state     body_queue       (S9)
   └────────────┴──────────────┴─────────────────┴─────────────────┘
                                         ▼
                              ┌─────────────────────┐
                              │  SyncStore  (§9)    │  ← plain expo-sqlite (§14.3),
                              │  per-account        │    SQLCipher flip later
                              └─────────────────────┘
```

**A. Delta** — drain `Mailbox/changes`, then `Email/changes`, advancing each cursor once per
fully-applied page. Cheap: an `updated` email costs a 3-property `Email/get`; a `destroyed` costs
nothing.

**B. Coverage** — owns *history*. `/changes` structurally never delivers mail that already existed
when the cursor was created, so coverage is the job that walks the envelope window, and the job
that runs when the window widens. It is also the bootstrap (§4).

**C. Bodies** — owns the expensive part. `created` emails enter A's path as envelopes only; C1
drains a durable queue at low priority. **C2 (new, S9)** backfills bodies for envelopes that are
already covered but have no body — the case that arises when the *body* window widens after
coverage has completed, and the self-heal for bodies dropped after repeated failure. Without C2,
widening body retention silently does nothing for already-covered envelopes.

### 2.1 Two record tiers, two retention windows

| Tier | Properties | Written by | Retention |
|---|---|---|---|
| **Envelope** | `EMAIL_LIST_PROPERTIES` (`email.ts:6-9`) | A, B | `offlineEnvelopeDays` |
| **Body** | `bodyStructure, textBody, htmlBody, bodyValues, attachments, blobId, bcc, replyTo, sentAt` | C1, C2 | `offlineBodyDays`, plus the MB cap |

Envelopes are ~1 KB and are what the offline list, the FTS index (step 9) and the retention
decision need. Bodies are ~10–500 KB and are only needed when a message is opened.

**Resolved since revision 1 (human decision):** the two windows are now *separate settings* and
**envelope retention is widened well beyond body retention.** The MB cap applies to bodies only,
so a widened envelope window costs kilobytes per message and never evicts a message out of the
offline list. Revision 1's single `offlineCacheDays` becomes `offlineEnvelopeDays` and
`offlineBodyDays`; the design is independent of the concrete default values, which are a one-line
settings change (§15 open question 1).

This decision is what makes S9's missing C2 job and S2's unpinned sweep floor consequential rather
than theoretical: a wide envelope window means a reconcile enumeration spans many cycles, and
body-window changes become a distinct, user-reachable operation.

### 2.2 Module layout (for the implementer, not built here)

```
src/sync/
  engine.ts        orchestration: triggers, single-flight, cycle budget, phase reporting
  cursor.ts        cursor state machine + the advance rules of §7.5
  apply.ts         PURE change application: (localState, page, fetched) -> mutations
  coverage.ts      job B
  bodies.ts        jobs C1 + C2
  overlay.ts       PURE read-time local-mutation overlay (§5.6)
  retention.ts     window + MB cap policy, eviction
  errors.ts        classify() and the taxonomy of §7.1
  states.ts        branded ChangesState / SnapshotState types (§3.2)
  store.ts         SyncStore interface (§9)
  store-sqlite.ts  the shipping backend (§9.2)
  store-memory.ts  in-memory backend for unit tests
src/stores/
  sync-status-store.ts   UI-facing status; supersedes the sync fields of offline-cache-store
```

`apply.ts` and `overlay.ts` being pure (no network, no storage, no Zustand) is a hard requirement:
every rule in §5, §6.3 and §11 must be unit-testable without a JMAP server or a device. It is the
only way the failure-mode table becomes a test suite rather than a promise. Per S11, the overlay is
a **parameter** to the read path, never a store read from inside `apply()`.

---

## 3. State / cursor model

### 3.1 What is persisted

```ts
/** Local account identity: `username@host`, from lib/account-utils.ts generateAccountId(). */
type LocalAccountId = string;

/** JMAP-level account id from the session (primaryAccounts[mail], or a shared/group account). */
type JmapAccountId = string;

/** Types we hold a /changes cursor for. NOT a list of push types. */
type CursorType = 'Email' | 'Mailbox';

interface SyncCursor {
  type: CursorType;
  jmapAccountId: JmapAccountId;
  /** See §3.2: a ChangesState from this (type, jmapAccountId), or a seeded SnapshotState. */
  state: string;
  /** True when the last page reported hasMoreChanges — a drain is unfinished. */
  drainPending: boolean;
  /** Set when the server invalidated us. Cleared only by a completed reconcile (§7.6). */
  invalidatedAt?: number;
  invalidatedReason?: 'cannotCalculateChanges' | 'oldStateMismatch' | 'corruptState' | 'manual';

  // ── anti-wedge counters (S6): PER CURSOR, not per account ──
  consecutiveFailures: number;
  /** The sinceState that failed; escalation only counts failures at the same position. */
  lastFailedState?: string;
  /** Current rung of the maxChanges ladder (§7.7). */
  maxChangesRung: 0 | 1 | 2 | 3;

  updatedAt: number;
}

interface CoverageState {
  jmapAccountId: JmapAccountId;
  /** ISO. Oldest receivedAt for which the ENVELOPE tier is known-complete. */
  coveredFrom: string | null;
  /** ISO. Ascending scan resume point; null when not scanning. */
  scanCursor: string | null;
  /** The retention floor this scan is working toward. */
  targetFrom: string;
  /**
   * S2 — the floor PINNED at reconcile start. The reconcile sweep deletes only against this
   * value, never against a targetFrom that moved while the reconcile was running.
   */
  sweepFloor?: string;
  /** Set when a retention widen arrived mid-reconcile and must be applied after the sweep. */
  deferredTargetFrom?: string;
  /** Durable trace of any tie-cluster skip taken by §6.1's last-resort rung. */
  gapMarkers?: Array<{ from: string; to: string; reason: 'tie-cluster-skip'; at: number }>;
  phase: 'never-run' | 'scanning' | 'reconciling' | 'complete';
  /** Progress, for the UI only. Never load-bearing. */
  seen: number;
  consecutiveFailures: number;
  updatedAt: number;
}

interface BodyQueueEntry {
  emailId: string;
  jmapAccountId: JmapAccountId;
  receivedAt: string;      // drives priority: newest first
  attempts: number;        // NEVER reset by a re-enqueue (S12)
  lastError?: string;
  nextAttemptAt?: number;
}

interface AccountSyncState {
  schemaVersion: number;
  cursors: SyncCursor[];      // keyed by (type, jmapAccountId)
  coverage: CoverageState[];  // keyed by jmapAccountId
  /** Sticky until a reconcile completes (§7.6). Survives restarts. */
  resyncRequired: boolean;
  /** Rolling count + window start for the reconcile ceiling of §7.6.1. */
  reconcilesInWindow: number;
  reconcileWindowStartedAt: number;
  /** Last observed retention floor, for the clock-jump guard of F44. */
  lastWindowFloor?: string;
  lastCycle?: {
    startedAt: number; finishedAt?: number;
    outcome: 'ok' | 'partial' | 'failed' | 'abandoned';
    /** True when ANY job committed something — drives the chaining rule of §10.3. */
    madeProgress: boolean;
    error?: string;
  };
}
```

`epoch` is deliberately **not** a field of `AccountSyncState` — see §8.3. It is owned by the
registry, outside the per-account namespace, because it must be monotonic *across* a purge.

Cursors are keyed by `(LocalAccountId, JmapAccountId, CursorType)`. All three are required.
`LocalAccountId` because the device holds up to 5 accounts (`account-utils.ts:MAX_ACCOUNTS`).
`JmapAccountId` because one JMAP session exposes the user's own account plus every shared/group
account, each with its own independent state token — exactly why `email-store.ts:101-121` already
keys `emailStates` this way. `CursorType` because RFC 8620 §5.2 state tokens are per-datatype.

**S1 — no whole-struct writes.** `AccountSyncState` is a *view*, not a write unit. Every mutation
goes through a field-level patch on `SyncTxn` (§9.1) applied under a per-account mutex with
read-merge-write. Revision 1's "write the cursor / coverage / flags last, as a single
`AccountSyncState` blob" is withdrawn: it loses concurrent updates from outside the cycle. The
concrete sequence it broke: a cycle loads the struct, the user taps *Clear cache* (which sets
`resyncRequired = true` and wipes records), the cycle's end-of-cycle commit writes its stale copy
back with `resyncRequired: false` and an advanced cursor — producing an empty record store with a
live cursor and no resync pending, which is precisely the state §8.1 exists to make unreachable.

### 3.2 Cursor provenance: two branded state types (S5)

Revision 1's I2 ("only a `Foo/changes.newState` may become a cursor") was **false as stated** — the
design's own bootstrap (§4.1) and reconcile (§7.6) seed cursors from a `Foo/get {ids: []}` `state`,
which RFC 8620 §5.1 makes a perfectly legitimate cursor. Stating an invariant the design itself
violates is how it gets bypassed at the one call site that matters, which is exactly D4's shape.
The real property is about **ordering**, not source, and it now has structural teeth:

```ts
/** From a Foo/changes response's `newState`. The only value the delta path may advance to. */
export type ChangesState = string & { readonly __brand: 'ChangesState' };
/** From a Foo/get response's `state`. A valid cursor ONLY under the ordering rule below. */
export type SnapshotState = string & { readonly __brand: 'SnapshotState' };

// ── V3: the commitment is branded too, not just documented ──
// A `unique symbol` field cannot be produced by an object literal outside this module
// (the symbol isn't exported), so `EnumerationCommitment` is genuinely unforgeable rather
// than unforgeable-by-convention.
declare const enumerationCommitmentTag: unique symbol;

export interface EnumerationCommitment {
  readonly [enumerationCommitmentTag]: true;
  readonly jmapAccountId: JmapAccountId;
  readonly snapshot: SnapshotState;
  readonly targetFrom: string;
  /** Which job minted it — reconcile additionally pins sweepFloor (§7.6 step 0). */
  readonly kind: 'bootstrap' | 'reconcile';
}

/** The ONLY constructor. Exported from coverage.ts / reconcile.ts, not from states.ts,
 *  so the mint site and the enumeration that justifies it live in the same module. */
export function mintEnumerationCommitment(args: {
  jmapAccountId: JmapAccountId;
  snapshot: SnapshotState;
  targetFrom: string;
  kind: 'bootstrap' | 'reconcile';
}): EnumerationCommitment;
```

- `SyncTxn.advanceCursor(key, next: ChangesState)` — the delta path's only cursor write. It cannot
  accept a `SnapshotState`; the compiler rejects D4's shape at the call site.
- `SyncTxn.seedCursor(key, commitment: EnumerationCommitment)` — writes the snapshot state *and*
  the `CoverageState` (`phase: 'scanning' | 'reconciling'`, `targetFrom`, `sweepFloor`) in the same
  transaction. A seed is therefore never durable without the durable commitment to enumerate that
  justifies it.
- **V3 — that last guarantee is now type-enforced.** Revision 2 declared
  `EnumerationCommitment` as a plain interface and asserted in a comment that it was "only
  constructible by coverage/reconcile" — which any module could falsify with an object literal,
  making the seed path's teeth strictly weaker than `advanceCursor`'s. The `unique symbol` tag above
  closes that: the tag is not exported, so `mintEnumerationCommitment` is the only way to obtain the
  type, and it lives in the module that also runs the enumeration. §13 has the corresponding
  type-level test.

**The ordering rule (the real invariant, restated as I2 in §3.4):** a `Foo/get` `state` may become
a cursor only when an enumeration that *starts after that state was captured* is durably committed
to rebuild the record set the cursor describes. Wrappers in `src/api/email.ts` return the branded
types (§12.1) so the distinction cannot be lost by passing a bare `string` around.

Note what this does *not* forbid: a seeded cursor may go live for the delta path **immediately**,
before its enumeration finishes (§7.6, per S9). The seeded state is the server's current state at
capture, so changes after it are delivered correctly. What the enumeration provides is *history
completeness*, and only the delete sweep depends on that.

### 3.3 What is deliberately *not* a cursor

- **`Email/get`'s `state` outside the §3.2 ordering rule** — see D4.
- **`Email/query`'s `queryState`** — belongs to a specific filter+sort. The engine's coverage job
  does not use `queryChanges`; the email-store owns `queryState` (`email-store.ts:169-173`).
- **The `newState` inside a pushed `StateChange`** — a *target*, not a starting point. See §10.4.
- **`sessionState`** — session-level; signals capability/account-set change (F19), not data change.
- **Thread state** — v1 keeps no local Thread table; `threadId` on the envelope suffices. No
  `Thread/changes` cursor.
- **`EmailDelivery`** — a push type only (`push-notifications.ts:103`); there is no
  `EmailDelivery/changes`. Wake signal only.

### 3.4 Invariants

Correctness reduces to these. Every rule in §5–§8 holds one of them; §11 is the enumeration of
attempts to break them.

- **I1 — cursor-last.** A cursor is written only *after* every record mutation implied by its page
  is durable. A crash re-delivers a page (at-least-once), never skips one.
- **I2 — cursor provenance is an ordering rule** (restated per S5). A cursor advances to a
  `ChangesState` from the same `(jmapAccountId, type)`; it may be *seeded* from a `SnapshotState`
  only inside an `EnumerationCommitment` whose enumeration starts after that snapshot. No other
  value, from any other source, ever becomes a cursor.
- **I3 — monotonic or invalidated.** A cursor moves forward through applied pages, or is explicitly
  invalidated and rebuilt (§7.6). Never cleared silently, never rolled back.
- **I4 — no silent write loss.** Every storage write either succeeds or raises. A failed write
  fails the cycle (closes D2).
- **I5 — idempotent application.** Applying the same page twice yields the same local state.
  Guaranteed by upsert-by-id, delete-if-exists, and RFC 8620 §1.2 ids never being reused.
- **I6 — account containment.** Every read and write is namespaced by `LocalAccountId`; every
  commit re-checks `(accountId, epoch)` before landing (closes D6).
- **I7 — deletion provenance.** A local email record is deleted only by (a) `Email/changes`
  `destroyed`, (b) retention eviction, (c) the reconcile sweep of §7.6 against its **pinned**
  floor, or (d) account purge. Never by inference from mailbox state (§5.5).
- **I8 — no cursor or ordering depends on the device clock** (narrowed per S16). Cursors are opaque
  server strings; the coverage scan's resume point is a server `receivedAt`. The *retention
  boundary* does read the device clock, so a large skew can move the window — bounded and
  self-correcting, but not free, so F44 adds a jump guard. Revision 1's blanket "no correctness
  impact" was too strong for a feature whose point is having mail while offline.
- **I9 — bounded work.** Every loop has an explicit budget and terminates.
- **I10 — no wedge.** No error path can leave an account permanently unable to progress. Repeated
  non-transient failure escalates to reconcile (§7.7), always achievable from cold.
- **I11 — sequential execution within an account** (new, per Part 3). Within a cycle the jobs run
  strictly in sequence and a job's fetch→apply pair is never interleaved with another job's apply.
  This is what keeps the three machines safely "independent"; §5.1 gives the timeline argument.
  Running bodies concurrently "because it's separate state" is forbidden.
- **I12 — field-level state writes only** (new, per S1). `AccountSyncState` is never written as a
  whole struct. All mutations are field-level patches under a per-account mutex, read-merge-write.
- **I13 — a corrupt state blob is a resync, not an empty cursor set** (new, per S15). If
  `AccountSyncState` fails to parse, the engine sets `resyncRequired = true` and treats every cursor
  as invalidated. Falling back to "no cursors" would leave a store full of unverified pre-existing
  records that no sweep ever visits.

---

## 4. Bootstrap vs. steady state — the decision

**Decision: replace the code, keep the shape.** The bootstrap remains a query-driven bulk scan —
`/changes` structurally cannot deliver pre-existing mail — but it is rewritten as job B rather than
reusing `runOfflineSync`, because three defects sit in the load-bearing part:

1. **No cursor capture.** `runOfflineSync` never obtains a state token. A first `Email/changes`
   after it would need a `sinceState` taken *after* the scan finished, so every change during the
   scan (minutes on a large mailbox) falls in a gap: not in the scan's results, not in the change
   stream. Permanent silent hole. Not fixable by adding a line — it dictates the order of
   operations (§4.1).
2. **Unstable, unresumable paging.** One 5000-id query. The obvious extension (`position`) is wrong
   under concurrent change (§6.2), and neither form resumes after an OS kill.
3. **Wrong granularity.** Full bodies up front, so the MB cap determines how many messages exist
   offline at all.

Kept deliberately: the `{days, maxMB}` policy shape, chunk-to-`maxObjectsInGet` batching, the
progress reporting `OfflineCacheBanner` renders, and oldest-first eviction.

### 4.1 Bootstrap sequence (mandatory order)

```
1. CAPTURE CURSORS FIRST, in one JMAP request, before touching any data:
     ['Mailbox/get', {accountId, ids: []}, '0']   -> SnapshotState (mailbox)
     ['Email/get',   {accountId, ids: []}, '1']   -> SnapshotState (email)
   Seed both via seedCursor(...) inside one EnumerationCommitment (§3.2), which in the
   same transaction writes coverage {phase:'scanning', targetFrom, sweepFloor: targetFrom}.
   (Email/get with ids:[] returning a usable state token is already relied on by
   getEmailsWithState(); email.ts:329-336.)

2. Full Mailbox/get -> upsert every mailbox row. Cheap, always complete, no paging.

3. The seeded cursors are LIVE from here: each subsequent cycle runs A1, A2 (delta) and
   only then B (the ascending keyset scan of §6.1), per I11's ordering. Bootstrap does not
   block delta sync, which matters now that the envelope window is wide (§2.1).

4. When the scan reaches targetFrom: coveredFrom = sweepFloor, phase = 'complete'.
   (Bootstrap has no delete sweep — there is nothing local to sweep. Only reconcile sweeps.)
```

Step 1 preceding step 3 is the point: the cursor is *older* than the data, so the first delta cycle
re-delivers some changes we already have. That is I5 doing its job — a handful of redundant upserts
is the correct price for a structurally gap-free handoff. The opposite order (scan, then capture) is
cheaper and silently loses mail; it must not be "optimised" back in.

The engine serves reads throughout: the UI shows partial coverage and the offline list simply has
less history than it eventually will. There is no "sync in progress, no data" state.

---

## 5. Change application: order and consistency

### 5.1 Order within a cycle, and why it is safe (S16)

```
A1. Mailbox/changes  — drained fully (or to budget)
A2. Email/changes    — drained page by page
B.  Coverage         — envelope scan / reconcile enumeration
C1. Body queue drain
C2. Body backfill
```

Mailbox before Email because folder rows are what the list UI resolves names and roles against, and
because a `created` mailbox should exist locally before envelopes referencing it land. This is a
*preference*, not a correctness dependency — §9.3's schema deliberately has no email→mailbox FK,
because the two streams are not transactionally coupled and either order can be observed.

Delta before coverage **is** load-bearing, and revision 1 left the reason implied. The hazard is
resurrection: coverage's query returns message X, X is destroyed server-side, delta reports it
`destroyed`, and if coverage's page were applied *after* that delete, X returns as a zombie no
future `/changes` page will ever re-report. Walking the timeline:

- **Coverage after delta** (the specified order): coverage's query executes after the delete was
  applied, and a JMAP query reflects current server state, so X cannot be returned. Safe.
- **Coverage before delta**: coverage applies X while it is still alive; the later `/changes` call
  reports the destroy and we delete it. Safe.

So either order is safe — **provided a job's query→apply pair is never interleaved with another
job's apply**, which is exactly I11. The unsafe configuration is not an ordering choice but
concurrency, and that is what I11 forbids. Belt-and-braces for the same class of bug: a body write
is conditional on its envelope still existing (§9.1), so a body fetched just before its envelope
was destroyed cannot land as an orphan (F48).

### 5.2 `Mailbox/changes` application

| Result | Action |
|---|---|
| `created` | `Mailbox/get` full object → upsert row. |
| `updated`, `updatedProperties` non-null and ⊆ {`totalEmails`,`unreadEmails`,`totalThreads`,`unreadThreads`} | `Mailbox/get {properties: updatedProperties}` → patch only those columns. |
| `updated`, `updatedProperties` null | `Mailbox/get` full object → upsert row. |
| `destroyed` | Delete the mailbox row **only**. Do not touch email records (I7). |

The optimisation is RFC 8621 §2.2: *"If only the `totalEmails`, `unreadEmails`, `totalThreads`,
and/or `unreadThreads` Mailbox properties have changed since the old state, this will be the list of
properties that may have changed"*, and *"If the server is unable to tell whether only counts have
changed, it MUST just be null."* Counts change on every delivery and every read, so on a busy
account this is the difference between patching four integers and re-fetching every folder object.
"May have changed" makes the list an upper bound, so patching exactly those columns is correct.

`MailboxChangesResult` (`email.ts:125-132`) does not surface `updatedProperties`; §12.1 adds it.

### 5.3 `Email/changes` application — the important one

Fixed by RFC 8621 §4.1: **`keywords` and `mailboxIds` are the only mutable Email properties.** Body
structure, body values, attachments, headers, `receivedAt`, `size`, `threadId`, `preview`,
`subject`, addresses and `hasAttachment` are immutable for the lifetime of the id. An `updated`
Email therefore *cannot* have a changed body, and re-fetching one is pure waste.

| Result | Fetch | Notes |
|---|---|---|
| `created` | `Email/get {properties: EMAIL_LIST_PROPERTIES}` | Envelope tier. Enqueue into `body_queue` **iff** inside the body window. Never fetch bodies inline. |
| `updated`, record present locally | `Email/get {properties: ['id','keywords','mailboxIds']}` | 3 properties. Never bodies. Patch in place; the existing body blob stays valid. |
| `updated`, record **absent** locally | **nothing** (S16) | Unconditional no-op. Filter absent ids out *before* issuing the fetch — cheaper, and it removes revision 1's F26 wording, which implied fabricating a `receivedAt` the 3-property response cannot supply and the schema's `NOT NULL` would reject. |
| `destroyed` | nothing | Delete envelope + body + membership rows + any `body_queue` entry. |

Absent-and-updated is safe to ignore because absence is always either "retention decided against
it" or "coverage hasn't reached it yet" — and coverage enumerates *current* state, so it will pick
the record up with the updated values anyway. Nothing needs the update replayed.

There is no `updatedProperties` on `Email/changes` (RFC 8621 §4.3 is a plain `/changes` method), so
a fetch is unavoidable for present `updated` ids — but a 3-property one, batched to
`maxObjectsInGet`. This is the largest efficiency difference from today and closes D1.

Batching: `created` and `updated` ids from a page go in **two** `Email/get` calls (different
`properties` sets), each chunked to `min(maxObjectsInGet, 200)`, packed into one JMAP request when
within `maxCallsInRequest` (`jmap-client.ts:462-467`).

`notFound`: an id in `created`/`updated` that `Email/get` omits was destroyed between the two calls.
Normal, not an error: skip it, no retry, do not fail the page.

### 5.4 Ordering within one page

RFC 8620 §5.2 permits overlap: *"If a record has been created AND updated since the old state, the
server SHOULD just return the id in the `created` list but MAY return it in the `updated` list as
well"*, and the same for updated+destroyed → `destroyed`. Created+destroyed *SHOULD* be omitted
entirely but is not forbidden.

**Rule: within a page, apply creates, then updates, then destroys.** Because ids are never reused
(RFC 8620 §1.2), a destroy always refers to the same record as any create/update of that id in the
same page, so destroy-last converges on the correct final state. The reverse order would resurrect a
dead id, spend a fetch, and get `notFound`.

**Pages are applied strictly in order, exactly once, before their cursor is written.** No
reordering, no cross-page batching, no parallel page application.

### 5.5 Mailbox/Email interaction

The streams are independent, so transiently inconsistent local states are normal and must be
tolerated, not repaired:

- **Envelope references a mailbox row we don't have:** keep the membership row. The folder appears
  when `Mailbox/changes` catches up; the messages are already there. No FK, no cascade (§9.3).
- **Mailbox destroyed, its emails still local:** delete only the mailbox row. If the server
  destroyed the messages too (`onDestroyRemoveEmails`), `Email/changes` reports them `destroyed`. If
  it moved them, their `mailboxIds` update arrives as `updated`. Truth arrives on the Email stream
  either way.
- **A record whose `mailboxIds` becomes empty:** keep it. It is reachable by id (notification tap,
  thread view) and will be reported `destroyed` if it truly is gone. It falls out of folder listings
  naturally — no membership rows, no listing hits.

This is I7 operationally: **email records are never deleted by inference.** Being wrong in that
direction costs a stale row the next cycle cleans up. Being wrong in the other direction costs a
message the user cannot read while offline — the exact failure this feature exists to prevent.

### 5.6 Local mutations: a read-time overlay, not a write-through (S11, revised)

Revision 1 had the engine re-apply pending outbox ops on top of each delta, and named no owner for
writing optimistic mutations into the durable store — leaving a reachable sequence that loses a
local mutation silently until restart. Rather than making that write-through atomic, **revision 2
removes the write path**:

- **The durable store holds server-derived state only.** Nothing optimistic is ever written into
  `envelope`/`body`.
- **`src/stores/outbox-store.ts` becomes the sole durable record of local intent** — and therefore
  has to actually be durable, which today it is not (V1, §5.6.1).
- **Reads compose the two**: `overlay.ts` exports a pure
  `applyPendingOps(record, pendingOps) → record`, and every read path that feeds the UI passes the
  account's pending ops through it (call sites enumerated in §12.3). A queued `destroy` hides the
  record from reads.
- **`apply()` never sees pending ops.** They are not a parameter to change application at all, so
  the delta path has no way to be wrong about them.

Why this is better than the review's suggested atomic write-through: it needs no cross-store
transaction (the outbox is a separate AsyncStorage bucket today), it cannot lose a mutation because
the only durable copy is the one the outbox already wrote, and it deletes the "delta reverts the
user's offline change" failure mode instead of guarding it — after a flush the server converges and
the op leaves the queue, so the overlay disappears on its own.

§12.3 records the consequence: `email-store.ts:38-41`'s `patchCache()` write-through is deleted, not
ported.

#### 5.6.1 Making the outbox actually durable (V1 — required, not optional)

Revision 2 asserted the outbox "already persists before the UI reports success." **That is false**,
and it matters more now than it did before, because revision 2 promoted the outbox from a
belt-and-braces queue to the *only* durable copy of a local mutation:

- `persist()` (`outbox-store.ts:69-73`) is `void AsyncStorage.setItem(...).catch(warn)` — the same
  fire-and-forget pattern D2 catalogues in `offline-cache-store` and §9.2 bans in the sync path.
- `enqueue` is typed `(op: OutboxOp) => void` (`:62`) and calls `persist()` as its last statement
  without awaiting (`:166-167`), so it returns before the write is on disk.
- `applyOrQueueBatch` therefore returns `{ queued: true }` (`:290-292`) — and the UI reports success
  — with nothing durable. A kill (or a failed write) in that window loses the mutation silently, and
  under revision 2's design there is no second copy to recover it from.

**Required change (§12.3):** `enqueue` becomes `async` and **awaits** the persist, `persist()`
propagates rejection instead of warning, and `applyOrQueueBatch` awaits every enqueue before
returning `{ queued: true }`. A failed enqueue must **raise to the caller** so the UI can surface
"couldn't save that change" rather than showing an optimistic state that no longer exists anywhere.
This is I4 applied to the outbox: revision 2's §9.2 already bans `void AsyncStorage.setItem(...)` in
the sync path, and the outbox is now part of that path in everything but name.

Callers to update: `applyOrQueue`/`applyOrQueueBatch` (`outbox-store.ts:268-297`) and the
`email-store` mutations that go through them (`markRead`, `markUnread`, `toggleStar`, `togglePin`,
`moveToMailbox`, `archiveEmail`, `deleteEmail`, and the batch variants). They already `await`
`applyOrQueue`, so the change is mostly internal to the store.

#### 5.6.2 What the overlay does *not* cover (V1)

Two claims from revision 2 are corrected here rather than implemented.

**Unread badge counts are not overlaid — retracted, and stated as a known limitation.** Revision 2
claimed "badge counts and list rows apply it." Only the second half is true. Every unread badge in
the app reads `Mailbox.unreadEmails`, a **server-maintained scalar** the engine patches from
`Mailbox/get` (§5.2): `SidebarDrawer.tsx:495`, `mailbox-tree.ts:162` (which aggregates it per
account), `EmailListScreen.tsx:815`, `FolderSettings.tsx:69` and `:193-195`. A per-email-record
overlay structurally cannot correct a per-mailbox aggregate — it has no way to know which of the
mailbox's *uncached* messages are unread, so it cannot recompute the total.

Options considered: maintain a per-mailbox tally of pending `$seen` transitions and subtract it from
the server scalar. Rejected for v1 — it means a second piece of derived state to keep consistent
with the queue (including coalescing, F41-style attempt drops, and flush completion), for a cosmetic
gain, and getting it wrong produces a *wrong number* rather than a stale one. **Decision: don't
overlay badges.** So while offline, marking a message read updates the row immediately and leaves
the folder's unread count stale until the outbox flushes and `Mailbox/changes` reports the new count.
This is **exactly today's behaviour** — `patchCache()` never touched mailbox counts either — so it is
not a regression; revision 2 simply claimed coverage it did not have.

**SQL-level predicates see server truth.** A query filtering on `keywords` (an offline unread
filter, or FTS in step 9) does not reflect unflushed intent; the overlay applies to rows *after* the
query returns. Also a limitation, also not a silent-loss risk: the durable copy of the intent is in
the outbox either way.

### 5.7 Boundary with `email-store`

| | Engine (this design) | `email-store` |
|---|---|---|
| Owns | durable local store, envelope+body tiers, `Email/changes` + `Mailbox/changes` cursors | the visible mailbox window, `queryState`, `Email/queryChanges` |
| Scope | whole account (all mailboxes, retention window) | one mailbox, one page, current filter |
| Lifetime | survives restart, drives offline reads | in-memory + persisted view snapshot |

Information flows **engine → email-store only**: the engine notifies "account X changed" and the
email-store decides whether the visible list needs a refresh (it already has `handleStateChange`,
`email-store.ts:969-1003`). The engine never reads the email-store's `queryState` or `emailStates`,
and vice versa. Two independent cursors over the same data is intentional redundancy: they page
differently, invalidate differently, and one being wrong must not corrupt the other.

`selectMailbox`'s cache seeding (`email-store.ts:646-663`) and `refreshEmails`'s offline fallback
(`:941-961`) keep working, reading through `SyncStore` — subject to §9.5's rule that a disabled
account's store is never opened.

---

## 6. Pagination and the `hasMoreChanges` drain

### 6.1 Coverage scan paging (job B)

Ascending keyset walk, not offsets:

```
page: Email/query {
  filter: { after: <scanCursor ?? targetFrom> },
  sort:   [{ property: 'receivedAt', isAscending: true }],
  limit:  PAGE (200),
  calculateTotal: false        // total is unstable and unused
}
-> Email/get envelope tier for the returned ids
-> commit: upsert envelopes, enqueue in-body-window bodies,
           set scanCursor = max(receivedAt) of the committed page
```

Ascending is the correct direction for a backfill: new mail arrives at the *tail*, so insertions
never shift rows the scan has passed. `scanCursor` is a server-provided `receivedAt` (I8), so it is a
meaningful resume point after a kill.

**`after` is inclusive — this is specified, not implementation-defined (S14).** RFC 8621 §4.4.1:
*"The `receivedAt` date-time of the Email must be the same or after this date-time to match the
condition."* (`before` is exclusive: *"must be before this date-time"*.) Revision 1's hedge
("exclusive in some implementations") was wrong and is withdrawn. Consequences:

1. Every page after the first re-returns the boundary message(s). Expected; dedupe by id on commit
   makes it free (I5).
2. Forward progress therefore requires `max(receivedAt) > scanCursor` **strictly**. A page whose
   every row shares one millisecond makes no progress.
3. **No-forward-progress guard**, in order:
   - Retry the page using the `anchor` / `anchorOffset` arguments of `Foo/query` (RFC 8620 §5.5,
     inherited by `Email/query`, RFC 8621 §4.4) from the last id of the previous page, for one page,
     then resume keyset.
   - If the anchor is rejected (`anchorNotFound`), **only then**: advance `scanCursor` by 1 ms, emit
     a `WARN`, and record a durable **gap marker** (`CoverageState.gapMarkers`). This rung can skip
     messages sharing the boundary millisecond on a conforming server, so it is never normal-path
     behaviour, is always logged, and leaves a recorded trace so a support question has an answer.
     A >200-message single-millisecond cluster is a corrupt server, not a case to design for.

`DISCOVERY_LIMIT` (5000) is replaced by two real bounds: the retention window (`targetFrom`) and a
per-cycle page budget (§6.4). A hard id cap is the wrong control — it truncates history silently
with no record of where.

### 6.2 Why not `position`-based paging

`Email/query {position: n}` over a mailbox receiving mail shifts every later page by the number of
insertions ahead of it. With descending sort, one delivery between page 1 and page 2 pushes one
message from page 1's boundary into page 2's start — and one *out* of the scan's reach entirely.
That message is pre-existing relative to our cursor, so `Email/changes` will never report it: a
permanent hole with no signal that it exists. This is D8; keyset ascending is immune by
construction.

### 6.3 Delta drain and mid-drain crash recovery (job A)

```
drain(type, jmapAccountId):
  budget = pagesRemaining()                             # I9
  loop:
    if budget-- <= 0: patch cursor.drainPending = true; return PARTIAL
    res = Foo/changes { accountId, sinceState: cursor.state,
                        maxChanges: rungValue(cursor.maxChangesRung) }

    if res is error:  -> §7 classification. Cursor position unchanged. Return.
    if res.oldState != cursor.state:  -> §7.6.1 (re-issue once, then reconcile). Return.

    apply(res)          # §5.3/§5.4; may commit records partially (§7.4)
    commit {
      records...,
      advanceCursor(key, res.newState),   # LAST (I1). No cast: res.newState is
                                          # already a ChangesState from the §12.1 wrapper.
      patch cursor { drainPending: res.hasMoreChanges,
                     consecutiveFailures: 0, lastFailedState: undefined,
                     maxChangesRung: 0 }
    }
    if !res.hasMoreChanges: return OK
```

**No `as ChangesState` cast anywhere (V3).** Revision 2's pseudocode wrote
`advanceCursor(key, res.newState as ChangesState)`, which is both redundant — §12.1's
`getEmailChangesResult` / `getMailboxChangesResult` already return branded states — and actively
harmful as a template: an `as` cast is precisely the escape hatch that defeats the brand, and
pseudocode gets copied. The rule for implementers: **a `as ChangesState` / `as SnapshotState` cast
outside `src/api/email.ts`'s response parsers is a bug.** Worth an eslint restriction if one is cheap
to express.

`rungValue(0) = min(maxObjectsInGet, 500)` (and rungs 1–3 are clamped to it — §7.7). Bounding
`maxChanges` keeps a page's fetch inside one
`Email/get` batch, so a page is a small, quickly-committable unit — which is what makes crash
recovery cheap.

**Crash / OS-kill mid-drain.** By I1 the last durable cursor is the `newState` of the last *fully
applied* page. On next launch:

1. `AccountSyncState` loads; `drainPending === true` says a drain was cut short, so the next cycle is
   scheduled immediately (T9) rather than waiting for a user trigger.
2. The interrupted page is re-requested with the same `sinceState` and re-applied. By I5 that is a
   no-op for everything already written and completes what wasn't.
3. Worst case: one page (≤500 ids of 3-property or envelope data) refetched.

RFC 8620 §5.2's intermediate-state guarantee is what makes this work: when `hasMoreChanges` is true
the returned `newState` may be passed back as `sinceState`. Persisting intermediate states is
sanctioned, and it is the only reason crash recovery costs one page instead of a resync.

`drainPending` is a scheduling hint, never a correctness input.

### 6.4 Budgets (I9)

| Bound | Foreground | Background (later) |
|---|---|---|
| Pages per cycle, per cursor | 40 | 8 |
| Wall clock per cycle | 90 s soft deadline, checked between pages | 25 s |
| Body queue items per cycle (C1+C2) | 200 | 20 |
| Coverage pages per cycle | 25 | 5 |

Exceeding a budget is a **normal** outcome (`partial`), not an error: the cursor stands at the last
committed page, `drainPending` stays true, T9 resumes. This is also the answer to a server whose
`hasMoreChanges` never goes false (F14) — the loop cannot spin forever and cannot wedge, because
progress is committed every page.

---

## 7. Errors, retry, and cursor-advance semantics

### 7.1 Taxonomy

JMAP reports failure at three layers and the current client flattens all of them (D5, and
`jmap-client.ts:442-445` throwing a bare `Error` for any non-2xx):

| Class | Examples | Retry | Cursor |
|---|---|---|---|
| **Transport** | offline, DNS, TLS, socket reset, timeout, RN `TypeError: Network request failed` | yes, backoff | unchanged |
| **RateLimit** | HTTP 429 + `Retry-After` (already `RateLimitError`, `jmap-client.ts:436-440`); request-level `urn:ietf:params:jmap:error:limit` with `limit: "rateLimit"` (RFC 8620 §3.6.1) | yes, honour `Retry-After` | unchanged |
| **ServerTransient** | HTTP 5xx; method-level `serverUnavailable`, `serverFail`, `serverPartialFail` (RFC 8620 §3.6.2) | yes, ≤2 attempts, then abandon cycle | unchanged |
| **RequestLimit** | `urn:…:error:limit` with `maxSizeRequest`/`maxCallsInRequest`; method-level `requestTooLarge` (RFC 8620 §5.1 — *"the number of ids requested by the client exceeds the maximum"*) | yes, once, with halved batch size | unchanged |
| **Auth** | HTTP 401 after the client's own refresh retry → `AuthenticationError` | no | unchanged |
| **Fatal** | `invalidArguments`, `unknownMethod`, `accountNotFound`, `accountNotSupportedByMethod`, `forbidden` | no | unchanged |
| **StateInvalid** | `cannotCalculateChanges`; confirmed `oldState` mismatch; corrupt state blob (I13) | no (goes to reconcile) | **invalidated** (§7.6) |

Exactly one row moves the cursor, and its action is a full verified rebuild. Everywhere else
**failure means the cursor stands still**, which is what makes "a failure never causes silent data
loss" structural rather than aspirational.

An **unrecognised** method-level error type is **ServerTransient**, not Fatal and never
StateInvalid. Guessing transient costs a retry; guessing state-invalid costs a full resync; guessing
fatal stalls the account. The cheapest wrong answer wins the default.

### 7.2 Backoff

Full-jitter exponential: `delay = random(0, min(cap, base * 2^attempt))`, `base = 1 s`,
`cap = 60 s` foreground / `15 min` background. Max 4 attempts per operation within a cycle, then the
cycle ends `failed` and the *cursor's* `consecutiveFailures` increments (§7.7). A `Retry-After`
always overrides a smaller computed delay.

Jitter matters because §10 has multiple independent triggers, up to five accounts, and a
network-recovery trigger that fires for everything at once — the exact shape that produces a
synchronised stampede against one Stalwart instance.

### 7.3 Offline is not an error

If `network-store.online` is false, or `jmapClient` has no live session (`auth-store` keeps
`session: null` in the authenticated-but-offline state, `auth-store.ts:502-514`), a cycle **does not
start**: outcome `abandoned`, no failure counters touched, no error surfaced (`OfflineBanner`
already tells the user). Same for the app backgrounding before a cycle begins.

### 7.4 Partial-failure semantics inside a page

The unit of atomicity is the *cursor*, not the record set:

- **Records may be committed partially.** If the `created` batch succeeds and the `updated` batch
  fails, the created envelopes stay written — correct data; discarding it would waste bandwidth. I5
  makes the replay overwrite them identically.
- **The cursor advances only when the entire page is applied.** One failed batch → cursor unchanged
  → the page replays.
- **Body failures never affect a cursor.** C1/C2 are separate state. A failed body increments
  `attempts` and sets `nextAttemptAt` with the same backoff; after 5 attempts the entry is
  **dequeued** and the message stays envelope-only (openable online, marked not-downloaded offline).
  Per S12: `notFound` dequeues **immediately** (the message is gone; a queue entry for it can never
  succeed and would otherwise burn five attempts), and a later re-enqueue is **insert-or-ignore that
  never resets `attempts`** — otherwise C2 re-enqueuing a permanently failing body would defeat the
  give-up rule and retry it forever.
- **Storage write failure is fatal for the cycle** (I4). Cursor unchanged, `failed`, surfaced. Never
  warn-and-continue (D2).

### 7.5 Cursor-advance rules, stated as one list

1. A cursor advances **only** to a `ChangesState` returned by `Foo/changes` for the same
   `(jmapAccountId, type)`, via `advanceCursor` (§3.2). The type system rejects anything else.
2. It may be **seeded** from a `SnapshotState` only inside an `EnumerationCommitment` whose
   enumeration starts after that snapshot and is durably committed in the same transaction (I2).
   This is the bootstrap/reconcile path and nothing else.
3. It advances only after all record mutations from that page are durable (I1).
4. It advances **on an empty page** (all three arrays empty, `newState` differing) — a legitimate
   no-op advance; skipping it would re-request forever.
5. It does **not** advance on any error class except StateInvalid, where it is invalidated and
   rebuilt (§7.6).
6. It never takes a value from a `queryState` or a pushed `StateChange` (§3.3).
7. It is **not cleared** by logout-of-another-account, a retention change, eviction, or a Settings
   "clear cache" (which clears *records* and sets `resyncRequired`, rather than nulling cursors).
8. It is **destroyed only** with its account's namespace, on purge (§8.4).

### 7.6 StateInvalid: the mandated rebuild, without blanking the UI

RFC 8620 §5.2 on `cannotCalculateChanges`: *"the server cannot calculate the changes from the state
string given by the client… The client MUST invalidate its Foo cache."* This is the mandated path,
not an edge case: our state is older than the server's change log, or the server lost/rebuilt data.

A literal reading ("delete everything, now") would empty a user's offline mail exactly when they may
be offline and depending on it. So:

```
onStateInvalid(jmapAccountId, type, reason):
  patch cursor { invalidatedAt, invalidatedReason: reason }      # this cursor is unusable
  patch account { resyncRequired: true }                         # sticky, survives restart
  # records stay readable, marked stale. Nothing is trusted as CURRENT.

reconcile(jmapAccountId):                                        # unconditional once required
  0. PIN THE FLOOR (S2): sweepFloor = current retention floor, written with phase='reconciling'.
     Every later step reads sweepFloor, never a live targetFrom.
  1. Capture fresh cursors (Mailbox/get ids:[], Email/get ids:[]) and seedCursor(...) them
     inside an EnumerationCommitment carrying sweepFloor  — BEFORE enumerating (§4.1).
     The seeded cursors are LIVE IMMEDIATELY: from this point the delta path runs normally,
     each cycle, alongside the enumeration (S9). Only the sweep waits.
  2. Full Mailbox/get -> upsert; delete mailbox rows not returned.
  3. Ascending keyset enumeration from sweepFloor over the whole envelope window,
     resumable via scanCursor, recording seen ids. Spans as many cycles as needed.
  4. SWEEP, gated on step 3 completing, and only against sweepFloor:
        delete every local email record with receivedAt >= sweepFloor not seen in step 3
        delete every local email record with receivedAt <  sweepFloor      # unverifiable
  5. coveredFrom = sweepFloor; clear sweepFloor; resyncRequired = false;
     clear cursor.invalidated*; phase = 'complete';
     AND reset cursor.consecutiveFailures = 0, lastFailedState = undefined,
     maxChangesRung = 0  for every cursor of this account            # V2
     If deferredTargetFrom is set (a retention widen arrived mid-reconcile),
     apply it now and set phase='scanning' to extend coverage downward (S2).
```

**V2 — step 5 resets the escalation counters, not just `invalidated*`.** Revision 2 cleared only the
invalidation fields, which left a completed reconcile carrying `consecutiveFailures: 5` and
`maxChangesRung: 3` into its fresh cursor: the very first post-reconcile failure would satisfy
`consecutiveFailures >= 5` and immediately re-escalate, so the account would ping-pong
reconcile → one failure → reconcile, bounded only by §7.6.1's 4-per-24 h ceiling. **Decision: reset
them.** A successful reconcile is by definition a clean position — a fresh cursor at a fresh state,
with the record set verified against it — so the failure history belongs to the *old* cursor and
carrying it forward measures nothing. The ceiling stays as the outer bound for the case where
reconciles genuinely keep being needed (F39).

**S2 — why step 0 exists.** Without a pinned floor, a user who widens retention *while* a reconcile
is running (very plausible: the "re-syncing offline mail" banner is exactly what prompts someone to
open Settings) makes step 4 sweep against the *new, wider* floor while step 3 only enumerated the
*old, narrower* one — deleting every record in the gap. Permanently: `coveredFrom` is then set to
the wider floor, so coverage believes that range is complete and delta sync cannot re-deliver
pre-existing mail. Pinning the floor and deferring the widen to step 5 closes it.

**S9 — why the delta path goes live at step 1.** Revision 1 forbade serving `/changes` until the
rebuild finished. With envelope retention now wide (§2.1), a reconcile enumeration spans many
cycles, so that prohibition would stall *all* incoming mail for the duration. The narrowed rule: the
freshly seeded cursor is live immediately (it is the server's current state, so changes after it are
delivered correctly, per §3.2); what the enumeration provides is history completeness, and only the
sweep depends on that.

Consequences, stated so they can be weighed:

- **Deliberate:** a user offline when invalidation is detected keeps readable (stale) mail instead of
  an empty inbox. The engine cannot even begin the rebuild while offline, so literal deletion would
  mean an indefinite blank.
- **Accepted cost:** between detection and the sweep, a server-side-deleted message may still be
  visible locally. Bounded by the reconcile completing, surfaced by the stale marker, no worse than
  the staleness offline already implies.
- **Forbidden:** serving `/changes` from the *invalidated* cursor (as opposed to the freshly seeded
  one), and letting the reconcile be skipped because some later cycle succeeded. `resyncRequired` is
  sticky until step 5.

Step 4's second clause matters: records older than the pinned floor cannot be verified by an
enumeration that only covers the window, so they are deleted rather than kept on faith. Normally
retention has already evicted them.

An invalidation of either cursor type reconciles that JMAP account as a whole — splitting it isn't
worth the reasoning burden when `Mailbox/get` is one cheap call.

### 7.6.1 `oldState` mismatch: confirm before escalating, and cap reconciles (S10)

RFC 8620 §5.2 has the server echo `sinceState` as `oldState`. A mismatch means the server is not
answering the question we asked, so revision 1 escalated straight to reconcile. But if a server ever
echoes a semantically-equal, non-byte-identical `oldState`, *every* cycle would trip it, reconcile,
seed a fresh cursor, and trip again — unbounded full-window rescans, and `consecutiveFailures` never
catches it because each reconcile "succeeds."

```
on oldState mismatch:
  re-issue the SAME Foo/changes call once and compare again.
    still mismatched -> StateInvalid (§7.6), reason 'oldStateMismatch'
    matched          -> treat as a transient anomaly: WARN, continue the drain

reconcile ceiling:
  reconcilesInWindow, reconcileWindowStartedAt (rolling 24 h) on AccountSyncState.
  > 4 reconciles in 24 h -> ERROR log with the reason distribution,
                            throttle to at most one reconcile per 24 h,
                            surface a persistent "offline mail can't stay in sync" state.
```

Throttling rather than *stopping* is deliberate: a hard stop would trade S10's loop for an I10
wedge. One reconcile per day still converges; the loud log and the UI state are what get a human
involved.

### 7.7 Anti-wedge escalation (I10) — per cursor, monotonically shrinking

Two corrections from the review.

**S6 — the counters move onto `SyncCursor`.** Revision 1 kept `consecutiveFailures` /
`lastFailedState` as scalars on `AccountSyncState`, while cursors are per-type. If `Mailbox` drains
cleanly every cycle and `Email` fails every cycle, a shared counter reset by "something succeeded"
never escalates, and the Email cursor never advances again — silently, forever. That is exactly the
wedge I10 exists to make unreachable. Counters are now per cursor, and:

> **For escalation purposes a cycle is `failed` if *any* job failed, regardless of what the others
> achieved.** `lastCycle.outcome` is the worst outcome across jobs, not the best. `madeProgress` is
> tracked separately (it drives chaining, §10.3), and success on one cursor never resets another
> cursor's counter.

**S7 — the ladder shrinks monotonically.** Revision 1 went 500 → 250 → *unbounded*, justified by a
claimed RFC ambiguity (that a server might fail a bounded change calculation while handling the full
one). The reviewer could not substantiate that against RFC 8620 §5.2 and **neither can I** — the
claim is withdrawn. Worse, removing the bound makes the retry strictly *larger* than the attempt
that just failed, which actively worsens the likeliest real cause (response too large).

**V2 — every rung is expressed relative to rung 0, not as a bare constant.** Revision 2 clamped only
rung 0 with `min(maxObjectsInGet, 500)` and wrote 250/50/25 as literals. `getMaxObjectsInGet()`
(`jmap-client.ts:455-460`) returns `core?.maxObjectsInGet || 500`, so a server advertising
`maxObjectsInGet = 100` gives rung 0 = 100 and rung 1 = 250 — **the first retry is larger than the
attempt that just failed**, which is S7's defect in a narrower form. Clamping each rung to rung 0
makes the ladder monotonically non-increasing for every possible server value:

```
rung0 = min(maxObjectsInGet, 500)

escalate(cursor) — counted only when lastFailedState == the state that failed again:
  rung 0: rung0                    (normal)
  rung 1: min(rung0, 250)
  rung 2: min(rung0, 50)
  rung 3: min(rung0, 25)
  consecutiveFailures >= 5, or a failure at rung 3
        -> StateInvalid (§7.6): reconcile, subject to §7.6.1's ceiling.
           Log loudly; surface "re-syncing offline mail".
```

Consequence worth noting: on a server with a small `maxObjectsInGet` some rungs collapse to the same
value (at `maxObjectsInGet = 20`, all four rungs are 20). That is correct — the ladder then buys
nothing and the escalation proceeds to reconcile on the counter alone, which is the right outcome
when the batch size was never the problem. `rung0` is recomputed per cycle, since `maxObjectsInGet`
can change when the session is re-read (F19).

Reconcile is always achievable — it needs only the calls a cold start needs — so a stuck cursor
self-heals within ~5 cycles at the cost of one window rescan. Any cycle in which *that cursor*
advances resets its counters and rung to 0.

---

## 8. Multi-account isolation

Confirmed requirement (manual §4: *"the mobile offline cache must isolate per-account, including
per-account SQLCipher keys later"*).

### 8.1 Namespacing

Every key derives from `LocalAccountId` (`username@host`, `account-utils.ts`). Under §14.3's
sequencing the per-account store is one SQLite database file; the logical namespace is the same
either way:

```
<per-account store>   -> mailbox, envelope, email_mailbox, body, body_queue, sync_state
                         (cursors, coverage, flags) — ALL of it inside the account's own store
vncmail:sync:registry -> ONLY: account ids present, purge tombstones, monotonic epochs
```

**No cursor, coverage row, record, or resync flag lives in a global key.** This is the
forward-compatibility requirement that makes step 6 work: when the store becomes a SQLCipher file,
deleting the key and the file removes all of that account's sync state together. A cursor in a
shared blob would survive the wipe and then be used against a freshly-empty store — advancing over
changes that would never be re-delivered. Exactly the silent-data-loss shape to design out now.

`epoch` is the one exception and is *not* sync state — it is a fencing token that must be
**monotonic across a purge** (§8.3), so it has to live outside the namespace being purged.

`vncmail:` rather than the upstream `webmail:` prefix, so the v2 caches
(`offline-cache-store.ts:16-17`) cannot alias and §14.1 can delete the old namespace wholesale.

**Accepted limitation (S16):** the registry stores plaintext `username@host` per account, outside
any encrypted store. An unencrypted index is unavoidable — the engine must know which accounts exist
and which purges are pending *before* any key is available. It adds no new exposure:
`src/stores/account-store.ts` already persists `username` and `email` for every account to plain
AsyncStorage under the `account-registry` key (`account-store.ts:150-151`). If that ever changes,
the registry should move to `expo-secure-store` with it.

### 8.2 JMAP-level accounts within one login

Cursors carry `jmapAccountId` (§3.1) and, per **S3**, so do the storage primary keys (§9.3). v1
syncs the **primary mail account only**; shared/group accounts stay online-only, as they effectively
are today (`email-store.ts:594-600`).

Revision 1 claimed adding them later would be "inserting rows, not migrating." That was only true of
the *cursor* schema — the SQL schema keyed rows by bare JMAP id, which S3 correctly identifies as
wrong, since JMAP ids are unique only within an account (the codebase already works around this with
`sharedMailboxId`, `email.ts:19-20`). With §9.3's account-scoped keys in place from day one, the
claim now holds.

### 8.3 Epoch: owner, storage, and bump list (S1, S13)

Revision 1 named `epoch` as the guard against late writes but never said who owned it, where it
lived, or how it was written — `SyncTxn` had no path for it at all.

- **Owner:** `SyncStoreFactory`. It is the only component that reads or increments epochs.
- **Storage:** the registry (§8.1) — outside the per-account namespace, so it survives a purge. This
  matters: if epoch reset to 0 when an account were purged and re-added, an in-flight cycle holding
  epoch 0 could commit into the fresh namespace. Monotonic-across-purge closes that.
- **Not writable from `SyncTxn`.** A transaction *reads* the epoch to validate itself and rejects
  with `EpochMismatchError` on a change; it can never bump one.
- **Bumped on:** login; logout; account switch *to* this account; purge; **`clearRecords()`**; **the
  offline-cache feature being disabled** (S13). The last two are the additions — both are concurrent
  mutations of a cycle's world, and without a bump the cycle's next commit would land on top of
  them.

Every cycle captures `(accountId, epoch)` at start and re-validates before **every** commit, and
additionally verifies that `jmapClient` currently serves that account before **every** network call
— not just at cycle start, because the cycle is long-lived and `switchAccount` can land in the
middle of it. That is the generalisation of `jmapClientServesActiveAccount`
(`email-store.ts:131-138`) and what closes D6: a fetch issued for account A can never be written
under account B, because the write's epoch check fails and, per I11, no other writer is racing it.

### 8.4 Logout, account removal, feature-disable, and the future key wipe

Skill step 7 will require wipe-on-logout for the SQLCipher key, so the lifecycle must respect that
boundary already:

```
purgeAccount(accountId,
             reason: 'logout' | 'removed' | 'feature-disabled' | 'store-format-change'):
  1. registry: add { accountId, purgePending: true }         # durable intent, crash-safe
  2. epoch++ (registry)  -> every in-flight cycle's next commit is rejected
  3. [once encrypted] delete the SQLCipher key from expo-secure-store
     -- FIRST, because it renders the data unreadable immediately even if the
        file delete fails or is interrupted
  4. delete the account's database file / all keys under its namespace
  5. registry: remove the entry (keep the epoch)
```

- **Crash between 1 and 5:** next launch sees `purgePending` and completes the purge **before any
  cycle starts**. A store missing arbitrary records while holding a live cursor is the worst possible
  state, and step 1 makes it unreachable.
- **Ordering 3 before 4** is the security property, not an optimisation: an interrupted purge must
  leave unreadable data, not readable data.
- **`logout()` of one of several accounts** (`auth-store.ts:286-334`) purges only that namespace;
  other accounts' cursors are untouched (§8.1).
- **`logoutAll()`** purges each namespace in turn.
- **Feature-disabled purges too (S13, decided).** Toggling offline caching off purges that account's
  store. Rationale: the user's intent in disabling is "don't keep my mail on this device", and once
  the store is encrypted a dormant database plus a live key in `expo-secure-store` is a liability
  with no benefit. Cost: re-enabling costs a full bootstrap, so the Settings toggle needs a
  confirmation ("this deletes mail downloaded to this device").
- **Re-login to a purged account** finds no state, so `coverage.phase === 'never-run'` and it
  bootstraps (§4). A stale cursor surviving a purge would be catastrophic; §8.1 + step 4 covering the
  same namespace as step 1's tombstone prevents it.
- **`AuthenticationError` during a cycle is *not* a purge signal** (§7.1: Auth → cursor unchanged,
  cycle abandoned). Only the auth store's explicit logout purges. A server hiccup returning 401 must
  never delete a user's offline mail.

#### 8.4.1 The out-of-band store-format marker (V4)

The encryption flip (§14.3 step 3.7) and any breaking schema bump both need "purge and re-bootstrap"
— but revision 2 left the *trigger* undefined, and worse, unimplementable as specified:
`schemaVersion` lives in `AccountSyncState`, i.e. **inside the SQLite file that the flip makes
unreadable**. You cannot read the version out of a database you can no longer open, so the code that
must decide "purge this" has nothing to decide on. Failure mode without a marker: the app opens a
plain database with a key (or vice versa), gets an opaque "file is not a database" / "file is
encrypted" error, and there is no defined path from there — likely an unrecoverable launch loop for
anyone upgrading with an existing store.

Fix — record the format **out of band**, in the registry (§8.1), next to the purge tombstone:

```
vncmail:sync:registry -> per account: {
  accountId, purgePending?, epoch,
  storeFormat: 'sqlite-plain' | 'sqlite-cipher',   # V4
  schemaVersion: number                            # mirror of the in-file value
}
```

At launch, **before** `completePendingPurges()` returns and before any cycle starts, the factory
compares each account's recorded `(storeFormat, schemaVersion)` against what this build expects. A
mismatch in either → `purgeAccount(accountId, 'store-format-change')`, then a normal bootstrap (§4).
The marker is written as the last step of materialising a store, so a crash mid-creation leaves a
missing/stale marker, which the same comparison treats as a mismatch — safe by default.

The marker is not secret (a format name and an integer), so the registry — plaintext AsyncStorage,
per §8.1's accepted limitation — is the right home: it must be readable *before* any key exists,
which is exactly the property needed here. Note this makes the registry's per-account record the only
thing that must be kept consistent with the store's existence; §8.4's step ordering (tombstone first,
marker last) is what keeps that one-way.

---

## 9. Storage-interface boundary

The engine talks only to `SyncStore`, so the SQLCipher flip (step 6) is a backend concern.

### 9.1 Interface sketch

```ts
/** One atomic unit of work. Under SQLite a real BEGIN…COMMIT. */
export interface SyncTxn {
  // ── records ──
  upsertMailboxes(rows: MailboxRow[]): Promise<void>;
  patchMailboxCounts(p: Array<{ key: RowKey; counts: Partial<MailboxCounts> }>): Promise<void>;
  deleteMailboxes(keys: RowKey[]): Promise<void>;

  upsertEnvelopes(rows: EnvelopeRow[]): Promise<void>;
  /** keywords + mailboxIds only — the Email `updated` path (§5.3). */
  patchEnvelopeMutable(p: Array<{
    key: RowKey; keywords: Record<string, boolean>; mailboxIds: Record<string, boolean>;
  }>): Promise<void>;
  /** No-ops if the envelope is gone — prevents orphan bodies (F48, §5.1). */
  putBodyIfEnvelopeExists(key: RowKey, body: BodyRow): Promise<boolean>;
  /** Removes envelope + body + membership + body_queue rows for each key. */
  deleteEmails(keys: RowKey[]): Promise<void>;
  deleteBodies(keys: RowKey[]): Promise<void>;

  // ── body queue (S12) ──
  /** Insert-or-ignore. NEVER resets `attempts` on an existing row. */
  enqueueBodies(entries: BodyQueueEntry[]): Promise<void>;
  /** Attempts/error/nextAttemptAt only. */
  updateBodyQueue(entries: BodyQueueEntry[]): Promise<void>;
  dequeueBodies(keys: RowKey[]): Promise<void>;

  // ── state: FIELD-LEVEL PATCHES ONLY (S1, I12). No whole-struct write exists. ──
  /** The delta path's only cursor write. Cannot accept a SnapshotState (§3.2). */
  advanceCursor(key: CursorKey, next: ChangesState): Promise<void>;
  /** Bootstrap/reconcile only; writes the coverage commitment in the same txn (§3.2). */
  seedCursor(key: CursorKey, commitment: EnumerationCommitment): Promise<void>;
  patchCursor(key: CursorKey, patch: Partial<Omit<SyncCursor,
    'type' | 'jmapAccountId' | 'state'>>): Promise<void>;
  patchCoverage(jmapAccountId: JmapAccountId, patch: Partial<CoverageState>): Promise<void>;
  patchAccountFlags(patch: Partial<Pick<AccountSyncState,
    'resyncRequired' | 'lastCycle' | 'reconcilesInWindow' | 'reconcileWindowStartedAt'
    | 'lastWindowFloor'>>): Promise<void>;
}

/** Row identity is (jmapAccountId, id) everywhere — S3. */
export interface RowKey { jmapAccountId: JmapAccountId; id: string }
export interface CursorKey { jmapAccountId: JmapAccountId; type: CursorType }

export interface SyncStore {
  readonly accountId: LocalAccountId;
  readonly epoch: number;

  /** Throws CorruptStateError; the caller applies I13 (resyncRequired) rather than
   *  falling back to empty cursors. */
  loadAccountState(): Promise<AccountSyncState>;

  /**
   * Runs `fn` as one unit, serialised by a PER-ACCOUNT MUTEX (S1) so a cycle commit and a
   * concurrent clearRecords()/settings change cannot interleave. State patches are applied
   * read-merge-write inside the same critical section. Rejects with EpochMismatchError if
   * the registry's epoch for this account changed since open.
   */
  transaction<T>(fn: (txn: SyncTxn) => Promise<T>): Promise<T>;

  // ── reads (offline UI, retention, FTS, body backfill) ──
  getEnvelope(key: RowKey): Promise<EnvelopeRow | null>;
  /** Bulk presence test — filters `updated` ids before fetching (§5.3). */
  whichEnvelopesExist(keys: RowKey[]): Promise<RowKey[]>;
  getBody(key: RowKey): Promise<BodyRow | null>;
  listMailboxes(jmapAccountId: JmapAccountId): Promise<MailboxRow[]>;
  /** Indexed. `hasBody: false` is job C2's driver (S9). */
  queryEnvelopes(q: {
    jmapAccountId: JmapAccountId;
    mailboxId?: string;
    receivedBefore?: string;
    receivedAfter?: string;
    hasBody?: boolean;
    limit: number;
    offset?: number;
  }): Promise<EnvelopeRow[]>;
  countEnvelopes(q?: { jmapAccountId?: JmapAccountId; mailboxId?: string }): Promise<number>;
  bodyBytesTotal(): Promise<number>;
  /** Oldest-body-first, from the body table alone (S12: it carries received_at). */
  listBodiesForEviction(limit: number): Promise<Array<{ key: RowKey; receivedAt: string; bytes: number }>>;
  /** Bodies with no surviving envelope — the orphan sweep (F45). */
  listOrphanBodies(limit: number): Promise<RowKey[]>;
  takeBodyQueue(limit: number, now: number): Promise<BodyQueueEntry[]>;

  /**
   * Records + body queue (S12), NOT cursors. Sets resyncRequired and bumps the epoch
   * via the factory (§8.3), so an in-flight cycle cannot write over it (S1).
   */
  clearRecords(): Promise<void>;
  /** Full namespace removal, per §8.4. */
  purge(): Promise<void>;
}

export interface StoreFormatMarker {
  storeFormat: 'sqlite-plain' | 'sqlite-cipher';
  schemaVersion: number;
}

export interface SyncStoreFactory {
  /** Lazy: never materialises a file or a key for an account whose feature is off (§9.5). */
  open(accountId: LocalAccountId): Promise<SyncStore>;
  isMaterialised(accountId: LocalAccountId): Promise<boolean>;
  listAccounts(): Promise<LocalAccountId[]>;
  epochFor(accountId: LocalAccountId): Promise<number>;
  bumpEpoch(accountId: LocalAccountId, reason: string): Promise<number>;

  // ── V4: out-of-band format marker (§8.4.1) ──
  /** Null when absent or unreadable — treated as a mismatch, i.e. purge. */
  readFormatMarker(accountId: LocalAccountId): Promise<StoreFormatMarker | null>;
  /** Written LAST when materialising a store, so a crash leaves a mismatch, not a false match. */
  writeFormatMarker(accountId: LocalAccountId, marker: StoreFormatMarker): Promise<void>;

  /**
   * Once at launch, before any cycle (§8.4). Completes pending purges AND purges any account
   * whose format marker doesn't match this build's expectation, with
   * reason 'store-format-change' (§8.4.1).
   */
  completePendingPurges(): Promise<void>;
}
```

The engine imports `SyncStore` and nothing else about persistence: no SQL, no `expo-sqlite`, no
AsyncStorage, no key strings outside `store*.ts`.

### 9.2 Which backend ships, and when (S4)

**Revised: plain `expo-sqlite` is the shipping backend, and it ships *before* the engine.**

Revision 1 planned an AsyncStorage backend first, with §9.3's SQLite schema as "step 6 shape." The
review is right that this is incoherent: §1.3 claimed D3 was closed by that schema while the
shipping backend couldn't implement an indexed `queryEnvelopes` at all. AsyncStorage leaves only two
options, both bad — repeat today's O(cache) scan (D3 ships unfixed), or rewrite a full
membership-index blob on every page commit (an availability problem in its own right, and much worse
now that the envelope window is wide, §2.1).

Reordering also fixes **S1** properly rather than by discipline: `transaction()` becomes a real
`BEGIN…COMMIT`, so cursor-last is enforced by the database instead of by write ordering plus a
mutex.

What this does *not* pull forward: **SQLCipher.** `expo-sqlite` works in Expo Go; only
`useSQLCipher` does not (manual §4). So plain SQLite keeps the current dev workflow intact and
leaves the human-gated key-lifecycle decision (skill step 7) exactly where it is. Enabling
encryption later changes the file format, which is free here because §14.1 already specifies
discard-and-rebuild: the flip is purge + re-bootstrap (triggered per §8.4's `store-format-change`).

> **V4 — verify this before scheduling on it.** "Plain `expo-sqlite` works in Expo Go" is inference
> from the manual's §4 note that *`useSQLCipher`* is the incompatible part, not something anyone has
> tested here: `expo-sqlite` is **not currently a dependency of this repo** (`package.json` has no
> `expo-sqlite` entry). The whole §14.3 reordering rests on it, so **step 3.1 starts by confirming
> it empirically** — add `expo-sqlite`, open a database in Expo Go on a device, and only then commit
> to the ordering. If plain `expo-sqlite` also needs a custom dev client on Expo SDK 54, the
> reordering still works but its "keeps the current dev workflow intact" benefit evaporates, and the
> §9.2 contingency (AsyncStorage first, D3 left open) becomes worth re-weighing. Cheap to check,
> expensive to assume.

Two backends therefore exist: `store-sqlite.ts` (the app) and `store-memory.ts` (unit tests, and the
second implementation that proves the boundary).

**Contingency, if the reordering is rejected** (e.g. `expo-sqlite` integration stalls): an
AsyncStorage backend is implementable, with these limits stated up front rather than discovered —
`transaction()` provides **ordering, not atomicity** (every record write awaited first, the state
patch last, so a crash can only leave records ahead of the cursor, which I5 makes harmless); the
per-account mutex becomes load-bearing rather than belt-and-braces; and **D3 ships unfixed** —
§1.3's "closed by" claim must stay withdrawn. `void AsyncStorage.setItem(...).catch(warn)` is banned
in the sync path either way (D2/I4).

Under SQLite the ordering requirement becomes redundant but harmless, and **no engine code changes**
— which is the test of whether this boundary was drawn in the right place.

### 9.3 Schema sketch

```sql
-- S3: every key is account-scoped. JMAP ids are unique only WITHIN an account
-- (the codebase already works around this at email.ts:19-20), so a bare-id PK would
-- silently merge two accounts' rows the moment shared/group accounts land — cross-account
-- leakage inside the design whose entire §8 is about isolation. Costs nothing today;
-- needs a real migration later.
CREATE TABLE mailbox (
  jmap_account_id TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT NOT NULL, parent_id TEXT, role TEXT, sort_order INTEGER,
  total_emails INTEGER, unread_emails INTEGER, total_threads INTEGER, unread_threads INTEGER,
  my_rights TEXT, is_subscribed INTEGER,
  PRIMARY KEY (jmap_account_id, id)
);
CREATE TABLE envelope (
  jmap_account_id TEXT NOT NULL, id TEXT NOT NULL,
  thread_id TEXT, received_at TEXT NOT NULL, size INTEGER,
  subject TEXT, preview TEXT, from_json TEXT, to_json TEXT, cc_json TEXT,
  has_attachment INTEGER, keywords_json TEXT NOT NULL,
  has_body INTEGER NOT NULL DEFAULT 0, body_bytes INTEGER NOT NULL DEFAULT 0,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (jmap_account_id, id)
);
CREATE INDEX envelope_received ON envelope(jmap_account_id, received_at DESC);
-- Job C2's driver (S9): envelopes inside the body window with no body yet.
CREATE INDEX envelope_nobody ON envelope(jmap_account_id, has_body, received_at DESC);
-- Membership is its own table: an email is in many mailboxes, and listing by folder must be
-- an index seek, not a scan of every cached body (D3).
CREATE TABLE email_mailbox (
  jmap_account_id TEXT NOT NULL, email_id TEXT NOT NULL, mailbox_id TEXT NOT NULL,
  PRIMARY KEY (jmap_account_id, email_id, mailbox_id)
);
CREATE INDEX email_mailbox_by_mailbox ON email_mailbox(jmap_account_id, mailbox_id);
-- S12: received_at lives here too, so eviction is a single-table ordered scan and cannot be
-- blinded by a missing/failed join to envelope.
CREATE TABLE body (
  jmap_account_id TEXT NOT NULL, email_id TEXT NOT NULL,
  received_at TEXT NOT NULL, json TEXT NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY (jmap_account_id, email_id)
);
CREATE INDEX body_received ON body(jmap_account_id, received_at ASC);
CREATE TABLE body_queue (
  jmap_account_id TEXT NOT NULL, email_id TEXT NOT NULL, received_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error TEXT,
  PRIMARY KEY (jmap_account_id, email_id)
);
CREATE TABLE sync_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);  -- cursors, coverage, flags
```

**Deliberately no foreign keys** from `email_mailbox.mailbox_id` → `mailbox`, and no cascade from
`envelope`. Per §5.5 the two change streams are not transactionally coupled, so membership rows
referencing a not-yet-fetched or already-destroyed mailbox are a normal transient state; an FK would
turn correct behaviour into a constraint violation, and a cascade on mailbox deletion would delete
mail, violating I7. Body/envelope consistency is maintained by `putBodyIfEnvelopeExists` +
`deleteEmails` + the orphan sweep, not by the schema.

`sync_state` sitting in the same file as the records is what makes §8.4's atomic wipe work.

### 9.4 Reserved hooks

- **FTS5 (step 9):** `upsertEnvelopes` / `putBodyIfEnvelopeExists` are the only write paths for
  indexable content, so index population is a trigger or an in-transaction insert there. No engine
  change. Note §5.6's consequence: an FTS/SQL predicate sees server truth, not unflushed local
  intent.
- **Attachment blobs:** today `expo-file-system` under `Paths.document/offline-attachments/`
  (`offline-cache-store.ts:2-4`). Out of scope; when added, blob deletion belongs in `deleteEmails`
  and `purge` so it cannot leak past an account wipe.

### 9.5 Lazy materialisation (S13)

`SyncStoreFactory.open()` **must not create** a database file (or, later, a SQLCipher key) for an
account whose offline caching is disabled. Revision 1 left the read paths
(`email-store.ts:646-663`, `:941-961`) calling into the store unconditionally, which — once step 6
lands — would materialise a per-account encrypted database and key for users who never enabled the
feature. Rules:

- Read paths check `offlineCacheEnabled` for that account **before** calling `open()`.
- `open()` on a non-materialised account returns a store in a read-only empty state and creates
  nothing; only a *write* materialises, and only the engine writes.
- `isMaterialised()` exists so Settings can show accurate storage stats without creating anything.

---

## 10. Triggering

### 10.1 Triggers

| # | Trigger | Job(s) | Throttle |
|---|---|---|---|
| T1 | Live session established (cold start) | A, B, C | 2 s delay (keeps today's behaviour, `App.tsx:280-282`) |
| T2 | App foreground (`AppState` → `active`) | A, C | min 30 s since last cycle |
| T3 | Pull-to-refresh | A, C | none (user-initiated); coalesces into a running cycle |
| T4 | Network regained (`network-store` false→true) | A, C | 3 s debounce + per-account jitter |
| T5 | Push `StateChange` (SSE now, WebSocket later) | A, C | 2 s debounce + the state-equality check of §10.4 |
| T6 | Retention setting changed | B (envelope widen), C2 (body widen), eviction only (narrow) | none |
| **T9** | **Unfinished work (S8):** previous cycle `partial`, **or** any cursor `drainPending`, **or** `coverage.phase` ∈ {`scanning`,`reconciling`}, **or** the body queue is non-empty | the unfinished job(s) | 5 s after the previous cycle, subject to §10.3's chaining rule |
| **T10** | **Offline caching disabled (S13)** | abort + purge (§8.4) | none |
| T8 | Background refresh (later, out of scope) | A, C with background budgets | OS-governed |

Revision 1 had no T9, so — as S8 shows — a large backlog could stall indefinitely: nothing
re-triggered a cycle purely because the previous one was `partial`, other than relaunch. A user who
enables the feature with a big mailbox and then stays foregrounded reading mail might never get a
second cycle. T9 closes that; T7 in revision 1 (`drainPending` at launch) is subsumed by it.

Explicitly **not** a trigger: a periodic foreground timer. T2/T4/T5/T9 cover the ground.
`push.ts:163-202`'s `startPolling` remains only as a *transport* fallback when neither WebSocket nor
SSE is available; its state-change events arrive as T5.

### 10.2 Not triggered by

Opening a mailbox, opening a message, or scrolling — those are `email-store` concerns with their own
network paths. The engine must never be on the critical path of a UI interaction; if it is, its
budgets and backoff become user-visible latency.

### 10.3 Single-flight, coalescing, and chaining (closes D7, S8)

Per `LocalAccountId`:

```
runCycle(accountId, reason):
  if inFlight(accountId):
     wakePending[accountId] |= reason        # remember WHY, don't abort
     return inFlight[accountId]              # callers await the same promise
  ...run jobs sequentially per I11...
  finally:
     if wakePending: schedule immediately
     else if unfinishedWork() && lastCycle.madeProgress: schedule via T9 (5 s)
     else if unfinishedWork(): STOP chaining — wait for a real trigger
```

The chaining rule is the guard S8's fix needs to avoid replacing a stall with a hot loop: **chained
cycles continue only while progress is being made.** A cycle that finishes with work outstanding and
`madeProgress: false` is not making headway (server refusing, budget-thrash), so chaining stops and
a genuine trigger — or §7.7's escalation — takes over.

A running cycle is never aborted to serve a new trigger (that was D7: "Sync now" during a sync
produced a cancelled sync and nothing else). It aborts only on: account switch, logout/purge,
**offline caching disabled (T10, S13)**, network loss, app background (at the next page boundary), or
a budget deadline — all of which leave a committed cursor and resumable state.

Cross-account: `jmapClient` is a singleton bound to one account, so v1 syncs **only the active
account**; a multi-account sweep needs a non-singleton client and is out of scope.

### 10.4 Push, and the WebSocket question

`StateChange` (RFC 8620 §7.1) is `{ changed: { <jmapAccountId>: { <type>: <newState> } } }` —
already typed (`types.ts:587-590`) and routed (`email-store.ts:969-1003`).

```
onStateChange(change):
  for (jmapAccountId, types) of change.changed:
    if not one of ours: ignore
    if types.Email   && types.Email   !== cursor(Email,   jmapAccountId)?.state: wake = true
    if types.Mailbox && types.Mailbox !== cursor(Mailbox, jmapAccountId)?.state: wake = true
    if types.EmailDelivery: wake = true          # no /changes for it; signal only
  if wake: debounce(2s) -> runCycle(reason: 'push')
```

Two load-bearing rules:

- **The pushed `newState` is never written as a cursor.** It is the server's *current* state; ours is
  our *last applied* state. Assigning it would skip every change in between — permanently, silently,
  and precisely for the mail the push was announcing. The most tempting wrong optimisation in the
  design.
- **State equality is a cheap, safe dedupe.** Pushed state equal to our cursor means we are already
  current; skip the round-trip. Common when our own mutation caused the change.

**JMAP WebSocket.** The Electron client confirmed `stalwart.sandbox.vnc.de` advertises
`urn:ietf:params:jmap:websocket` with `supportsPush: true` at `wss://…/jmap/ws` (manual §4/§5,
independently confirmed twice). **Decision for mobile: yes, eventually — foreground only, as a
transport swap behind the same handler.** The constraint that imposes now is that the engine's push
entry point is `onStateChange(change: StateChange)` and nothing else:

```
foreground: WebSocket (if advertised) -> SSE (push.ts:120) -> polling (push.ts:163)
background: FCM/APNs via vncmail-relay -> wakes the app -> T5/T8
```

A mobile app must not hold a WebSocket open in the background (doze, battery, socket reclamation);
the relay path exists for that. Because all three foreground transports emit the same `StateChange`,
swapping them changes zero engine lines.

### 10.5 Headless-callability constraint

Even with background scheduling out of scope, the engine must already satisfy: no dependency on
React, a mounted component, or a Zustand store for *correctness* (progress reporting is an optional
observer); a cycle callable as `runCycle(accountId, {budget: 'background'})`; and a cooperative
deadline checked between pages so it can commit and return before the OS budget expires. Nearly free
now; retrofitting it means unpicking store coupling later.

---

## 11. Failure-mode enumeration

Each row is a concrete scenario with a concrete rule, intended to become a test case (§13).
Rows added or rewritten in revision 2 are **bold**.

| # | Scenario | Rule |
|---|---|---|
| F1 | App killed by OS mid-page-drain | Cursor is the last fully-applied page (I1). Next launch sees `drainPending`, T9 fires, the same `sinceState` is re-applied idempotently (I5). Cost ≤1 page. |
| F2 | App killed mid-body-download | Body queue entry stays queued (separate state). Envelope already durable. Next cycle re-fetches. Cursor untouched. |
| F3 | App killed mid-bootstrap scan | `scanCursor` is the last committed page's `max(receivedAt)`; the scan resumes there. Cursors were seeded in step 1 (§4.1), so nothing is lost regardless of when the kill happened. |
| F4 | App killed mid-purge | `purgePending` tombstone; purge completes at next launch **before** any cycle runs (§8.4). |
| F5 | Two rapid foreground events → overlapping runs | Single-flight; the second call sets `wakePending` and awaits the in-flight promise. No abort (closes D7). |
| F6 | Pull-to-refresh during a running cycle | Same as F5. User-initiated triggers never cancel work. |
| F7 | Mailbox deleted server-side mid-sync | `Mailbox/changes destroyed` → delete the mailbox row only. Email records untouched (I7); truth arrives on `Email/changes`. No cascade. |
| F8 | Envelope references a mailbox we haven't fetched | Keep the membership row; no FK (§9.3). Folder appears when `Mailbox/changes` catches up. |
| F9 | `cannotCalculateChanges` | StateInvalid → invalidate cursor, `resyncRequired`, reconcile per §7.6 with a **pinned** `sweepFloor`. Records stay readable, marked stale, until the sweep. |
| F10 | Server rebuild / `newState` unrecognised | Detected as F9 or via `oldState` mismatch (F39). Same reconcile path. A cursor is never silently replaced (I2/I3). |
| F11 | `Email/get` returns `notFound` for a `created`/`updated` id | Destroyed between the calls. Skip the id; the page still counts as applied; no retry, no error. |
| F12 | `Email/get` batch fails mid-page (5xx) | Records already written stay (§7.4); cursor unchanged; the page replays. |
| F13 | Network drops mid-cycle | Transport → cursor unchanged, cycle `abandoned`/`failed`; T4 re-triggers on recovery. No error banner while the device reports offline (§7.3). |
| F14 | `hasMoreChanges` never becomes false | Page budget (§6.4) ends the cycle `partial` with the cursor at the last committed page; T9 resumes. Progress every cycle; no loop (I9), no wedge. |
| F15 | HTTP 429 / `error:limit` `rateLimit` | RateLimit: honour `Retry-After` (`jmap-client.ts:436-440`), full-jitter backoff, cursor unchanged. |
| F16 | Unrecognised method error type | Default ServerTransient — retry and back off. Never Fatal, never StateInvalid (§7.1). |
| F17 | `invalidArguments` (our bug) | Fatal: no retry, cursor unchanged, `failed`, logged loudly. Escalates via §7.7 after 5 cycles, so even our own bug can't wedge the account (I10). |
| **F18** | Same `sinceState` fails repeatedly | §7.7 ladder, **monotonically smaller** (500→250→50→25), then reconcile subject to §7.6.1's ceiling. Self-heals. |
| F19 | `sessionState` changed | Re-read the session; if the primary `jmapAccountId` changed, treat old cursors as another account's and reconcile. Re-read `maxObjectsInGet` / `maxCallsInRequest` for batch sizing. |
| F20 | 401 mid-cycle after the client's own refresh | Auth: cursor unchanged, cycle abandoned. **Never** purges or clears records (§8.4). |
| F21 | Account switched mid-cycle | Epoch guard rejects the next commit; cycle abandoned; plus a per-network-call check that `jmapClient` still serves this account, so a fetch for A can't be written under B (I6, closes D6). |
| F22 | Logout mid-cycle | Epoch bump + purge tombstone; in-flight commits rejected; the purge completes even mid-page. |
| **F23** | **Envelope window widened** | Not a resync. `targetFrom` moves back, `phase='scanning'`, job B scans ascending from the new floor to `coveredFrom`. Cursors untouched (§7.5 rule 7). |
| **F23B** | **Envelope window narrowed** | Evict envelopes (and their bodies, membership, queue rows) below the new floor; `coveredFrom = targetFrom`. Cursors untouched. |
| **F24** | **Body window widened** | Job **C2** (S9) enqueues bodies for `queryEnvelopes({hasBody: false, receivedAfter: bodyFloor})`. Without C2 this silently did nothing for already-covered envelopes — revision 1's gap. |
| **F24B** | **Body window narrowed** | Delete bodies below the new body floor and drop their queue entries; envelopes stay, so messages remain listed and openable online. |
| F25 | MB cap exceeded | Evict **bodies** oldest-first via `listBodiesForEviction` (single-table, `body.received_at`, S12). Envelopes survive. Cursors untouched. Queue entries for evicted-window messages dropped. |
| **F26** | `updated` for an id we don't hold | **Unconditional no-op** (S16): absent ids are filtered out before the fetch is issued. Absence means retention decided against it, or coverage hasn't reached it — and coverage enumerates current state, so it needs no replay. Revision 1's "let retention decide" wording implied fabricating a `receivedAt` the 3-property response can't supply and `NOT NULL` would reject. |
| F27 | `destroyed` for an id we never held | No-op. Page still applied, cursor still advances. |
| **F28** | Delta would revert an unflushed offline mutation | Cannot happen: the durable store holds server truth only and local intent is a **read-time overlay** (§5.6, S11). The delta path has no knowledge of pending ops. |
| **F29** | Pending `destroy` for a message the delta reports `created`/`updated` | Server state is applied; the overlay hides it from reads; the flush + subsequent `destroyed` removes it. No body is enqueued for a message with a pending destroy. |
| F30 | Storage write fails (disk full, quota) | Cycle fails immediately, cursor unchanged, error surfaced (I4). Never warn-and-continue (D2). |
| **F31** | Device clock wrong / DST | No cursor or ordering impact (I8): cursors are opaque server strings, `scanCursor` is a server `receivedAt`. Window boundary effects: F44. |
| F32 | Corrupt local *record* (unparseable row) | Delete the record, enqueue a re-fetch, log. Do **not** invalidate the cursor — one bad row is not a state problem. (Contrast F43.) |
| **F33** | Coverage scan makes no forward progress (`receivedAt` tie cluster) | `after` is spec-inclusive (S14), so boundary re-delivery is normal and deduped. Progress requires strictly-greater `max(receivedAt)`; otherwise the `anchor` guard, then — only on `anchorNotFound` — a +1 ms advance with a `WARN` and a durable gap marker (§6.1). Never normal-path. |
| F34 | Two devices on the same account | Nothing special. Cursors are per-device; each converges. The other device's mutations arrive as ordinary `updated`. |
| **F35** | User clears the cache from Settings while a cycle runs | `clearRecords()` wipes records **and the body queue** (S12), sets `resyncRequired`, and bumps the epoch (§8.3) — so the in-flight cycle's next commit is rejected and cannot revive `resyncRequired: false` (F37). Cursors are not nulled (§7.5 rule 7). |
| F36 | `hasMoreChanges: true` with all-empty arrays | Valid page: advance to `newState`, keep draining. Counts against the page budget, so a server doing this forever still terminates. |
| **F37** | **Concurrent non-cycle write vs. a cycle's commit (S1)** | No whole-struct `AccountSyncState` write exists (I12). Field-level patches, read-merge-write under the per-account mutex, plus the epoch guard. The broken sequence — cycle loads state → user clears cache → cycle writes its stale copy back, yielding an empty store with a live cursor and no resync pending — is unreachable. |
| **F38** | **Retention widened *during* a reconcile (S2)** | The sweep uses the **pinned** `sweepFloor` from reconcile step 0, never a live `targetFrom`. The widen is stored as `deferredTargetFrom` and applied at step 5, which then re-enters `phase='scanning'` to extend coverage downward. Without pinning, step 4 would delete every record between the old and new floors — permanently, since `coveredFrom` would then claim that range complete and delta sync cannot re-deliver pre-existing mail. |
| **F39** | **Server echoes a semantically-equal but non-identical `oldState` (S10)** | Re-issue the same call once and compare again; a match is a logged transient anomaly, not an invalidation. Only a confirmed mismatch escalates. Plus the ≤4-reconciles-per-24 h ceiling with a loud log and a persistent UI state (§7.6.1), so this cannot become an unbounded rescan loop that `consecutiveFailures` never sees. |
| **F40** | **Body fetch returns `notFound` (S12)** | **Dequeue immediately.** The message is gone; the entry can never succeed and would otherwise burn five attempts and leave a row behind. |
| **F41** | **Body re-enqueued after being dropped (S12)** | `enqueueBodies` is insert-or-ignore and **never resets `attempts`**, so C2 cannot defeat the give-up-after-5 rule by re-enqueuing a permanently failing body. |
| **F42** | **Offline caching disabled mid-cycle (S13)** | T10: abort at the next page boundary, bump the epoch (so in-flight commits are rejected), then purge (§8.4). Reads for a disabled account never open the store, and `open()` never materialises a file or key (§9.5). |
| **F43** | **`AccountSyncState` blob unparseable (S15)** | I13: `resyncRequired = true` and every cursor treated as invalidated → reconcile. **Not** a silent fall back to empty cursors, which would leave a store of unverified pre-existing records that no sweep ever visits. |
| **F44** | **Large device-clock jump when computing the retention floor (S16)** | Guard: if the computed floor moves more than 25 h from `lastWindowFloor`, log a `WARN` and keep the previous floor for eviction and for any sweep until a second, consistent observation. Prevents a skew from triggering a delete-and-redownload of the whole window. Bounded and self-correcting either way, but revision 1's "no correctness impact" was too strong for a feature whose point is having mail offline. |
| **F45** | **Orphan body rows (S12)** | `putBodyIfEnvelopeExists` prevents most; a periodic `listOrphanBodies` sweep deletes the rest. Otherwise they consume the user's storage cap while being invisible to eviction. |
| **F46** | **Big backlog, user stays foregrounded (S8)** | T9 reschedules 5 s after a `partial` cycle. Chaining continues only while `madeProgress` is true (§10.3), so a stall is fixed without creating a hot loop. |
| **F47** | **`Mailbox` drains cleanly while `Email` fails every cycle (S6)** | Failure counters live on `SyncCursor`, not `AccountSyncState`; a cycle counts as `failed` for escalation if **any** job failed. So the Email cursor's ladder escalates on schedule instead of being reset to 0 by the Mailbox cursor's success — the exact wedge revision 1 left reachable. |
| **F48** | **Body arrives for an envelope destroyed in the same cycle (Part 3)** | I11 (sequential jobs, no interleaved apply) makes it rare; `putBodyIfEnvelopeExists` makes it impossible. This is why "run bodies in parallel, it's separate state" is forbidden. |
| **F49** | **Reconcile of a wide envelope window takes many cycles (S9)** | Delta goes live at reconcile step 1 and runs every cycle alongside the enumeration; only the sweep is gated on enumeration completion. New mail keeps arriving during a multi-cycle rebuild. |

---

## 12. Required changes outside the engine

### 12.1 `src/api/email.ts` — typed results and branded states

Stop collapsing every error to `null` (D5, the trigger for D4):

```ts
export type JmapMethodErrorType =
  | 'cannotCalculateChanges' | 'serverUnavailable' | 'serverFail' | 'serverPartialFail'
  | 'requestTooLarge' | 'invalidArguments' | 'unknownMethod' | 'forbidden'
  | 'accountNotFound' | 'accountNotSupportedByMethod' | 'stateMismatch' | 'anchorNotFound'
  | 'unknown';                       // -> ServerTransient by default (§7.1)

export interface JmapMethodError { type: JmapMethodErrorType; description?: string; raw?: unknown }
export type JmapResult<T> = { ok: true; value: T } | { ok: false; error: JmapMethodError };

// newState/oldState are ChangesState; nothing else in the codebase can mint one (§3.2).
export function getEmailChangesResult(
  sinceState: string, opts?: { maxChanges?: number; accountId?: string },
): Promise<JmapResult<EmailChangesResult>>;
export function getMailboxChangesResult(
  sinceState: string, opts?: { accountId?: string },
): Promise<JmapResult<MailboxChangesResult>>;   // + updatedProperties: string[] | null
```

Also:
- `MailboxChangesResult` gains `updatedProperties: string[] | null` (§5.2).
- `getEmailProperties(ids, properties, accountId)` — a generic `Email/get` for the 3-property
  `updated` path and the envelope tier, returning its `state` as a **`SnapshotState`** so it cannot
  be handed to `advanceCursor` (D4 becomes a compile error).
- `getMailboxProperties(ids, properties, accountId)` for the `updatedProperties` patch path.
- `queryEmailWindow({after, before, limit, sort, anchor, anchorOffset, accountId})` for §6.1's
  keyset scan, returning `{ ids }` and surfacing `anchorNotFound` distinctly.
- `captureStates(accountId)` — the one-request `Mailbox/get{ids:[]}` + `Email/get{ids:[]}` pair of
  §4.1, returning branded `SnapshotState`s.

The existing `getEmailChanges` / `getMailboxChanges` stay as thin wrappers so `email-store` is
untouched by this step. **Fixing D4 in `email-store.ts:885-889` is a separate, small commit** — a
real bug in shipped code, independent of this engine, and worth landing on its own.

### 12.2 `src/api/jmap-client.ts`

- Parse request-level errors: RFC 8620 §3.6.1 returns HTTP 400 with `application/problem+json` and a
  `type` URN (`urn:ietf:params:jmap:error:limit` carries
  `limit: "maxSizeRequest" | "maxCallsInRequest" | "maxConcurrentRequests" | "rateLimit"`).
  `request()` currently throws `new Error("JMAP request failed: " + status)` for any non-2xx
  (`:442-445`), discarding it. Add `RequestLimitError` / `ServerError` carrying the parsed type so
  §7.1 can classify.
- Accept an `AbortSignal` so a cycle can be cut at a page boundary on background/logout/T10, and add
  a per-request timeout: `secureFetch`'s native path takes `timeoutMs`, but the plain `fetch` path
  has none, so a hung socket currently hangs a cycle until the OS gives up.
- Expose `sessionState` from responses (already typed, `types.ts:33-36`) for F19.

### 12.3 Stores and UI

- **New** `src/stores/sync-status-store.ts` — phase/progress/error for the banner; an observer of the
  engine, never an input to it.
- **New** `src/sync/overlay.ts` — the pure read-time local-mutation overlay (§5.6). Its arrival
  **deletes** `email-store.ts:38-41`'s `patchCache()` write-through and
  `offline-cache-store.patch()`; optimistic state is no longer written into the durable store at
  all. `dropFromCache()` (`email-store.ts:42-44`) likewise goes: a queued `destroy` is hidden by the
  overlay and removed for real when `Email/changes` reports it.
  **Every read path that feeds the UI must apply it (V1) — the complete list:**
  1. `email-store.selectMailbox`'s cache seed (`:646-663`) — list rows.
  2. `email-store.refreshEmails`'s offline fallback (`:941-961`) — list rows.
  3. `email-store.getEmailDetail`'s cached single-message fallback (`:1034-1056`, cached read at
     `:1053`) — **missed by revision 2's list.** Without it, opening a message offline after marking
     it read offline shows it unread again, which is the most visible possible instance of the bug
     the overlay exists to prevent.

  Not overlaid, per §5.6.2: unread badge counts (`SidebarDrawer.tsx:495`, `mailbox-tree.ts:162`,
  `EmailListScreen.tsx:815`, `FolderSettings.tsx:69`/`:193-195`) and SQL-level `keywords` predicates.
- `outbox-store.ts` — **a persistence change IS required (V1, §5.6.1)**, reversing revision 2's
  "no persistence change needed": `persist()` must propagate rejection instead of
  `void …catch(warn)` (`:69-73`), `enqueue` becomes `async` and awaits it (`:62`, `:166-167`), and
  `applyOrQueue`/`applyOrQueueBatch` (`:268-297`) await every enqueue before returning
  `{ queued: true }`, raising to the caller on failure. Plus the addition revision 2 already noted: a
  selector for "all pending ops for this account, keyed by email id", cheap enough to call on every
  read path.
- `offline-cache-store.ts` — its `SyncState`/`SyncPhase` and record cache are superseded.
  `OfflineCacheBanner` needs the new phases (`bootstrapping`, `delta`, `bodies`, `resyncing`,
  `partial`) mapped onto its existing five. `AboutDataSettings` gains an envelope/body split, a
  "re-sync now" action, and the §8.4 confirmation on disabling.
- `email-store.ts` — cache-seed (`:646-663`) and offline-fallback (`:941-961`) reads move to
  `SyncStore.queryEnvelopes` + the overlay, gated by §9.5's enabled check. Its `queryChanges` path is
  unchanged.
- `src/lib/offline-sync.ts` — deleted; `formatBytes` (`:150-155`) moves to a util (imported by
  `OfflineCacheBanner:10`, `AboutDataSettings:12`).
- `settings-store.ts` — `offlineCacheDays` splits into `offlineEnvelopeDays` / `offlineBodyDays`
  (§2.1).

---

## 13. Test plan

The `[QA]` gate for this step. `apply.ts` and `overlay.ts` being pure is what makes most of it cheap.

**Unit, no network (vitest, the repo's existing runner):**
- Every §11 row expressible as `apply(localState, page, fetched) → mutations`: F7, F8, F11, F26, F27,
  F36, F48, plus §5.4's create/update/destroy overlap ordering.
- Overlay: F28/F29 as pure `applyPendingOps` cases.
- Cursor state machine: all eight rules of §7.5. **Per S5 the D4 regression test is a type-level
  test** (`advanceCursor` must not accept a `SnapshotState`) *plus* a runtime test that the seed path
  requires an `EnumerationCommitment`. Revision 1's test — "a `get` state is rejected as a cursor" —
  was itself wrong, since bootstrap and reconcile legitimately seed from one; that is precisely how
  the literal rule would have been bypassed at the one call site that matters.
- **Type-level (V3): a plain object literal is rejected where `EnumerationCommitment` is expected**,
  mirroring the `advanceCursor`/`SnapshotState` test. Both are `@ts-expect-error` assertions in a
  `*.type-test.ts` compiled by `npm run typecheck` — a type-level test only earns its keep if a
  regression fails the build, so these must not live in a file the typecheck skips. Add a third: no
  `as ChangesState` / `as SnapshotState` cast exists outside `src/api/email.ts` (grep-based
  assertion or an eslint `no-restricted-syntax` rule; §6.3).
- `classify()` over the whole §7.1 taxonomy, including the unknown-type default (F16).
- **Escalation ladder (V2):** monotonic *non-increasing* for a range of `maxObjectsInGet` values —
  explicitly including a server advertising less than 250 (assert rung 1 ≤ rung 0, which is the
  regression test for the bare-constant bug) and one advertising less than 25 (all rungs collapse,
  escalation still terminates). Plus per-cursor counters and "any job failed ⇒ cycle failed" (F47),
  and that a completed reconcile resets `consecutiveFailures`/`maxChangesRung` (§7.6 step 5).
- **Outbox durability (V1):** `enqueue` rejects when the underlying write rejects, and
  `applyOrQueueBatch` does not return `{ queued: true }` before the write resolves. Fake a failing
  AsyncStorage; assert the caller sees an error rather than a silent success.
- Backoff: monotonic, jittered, capped, `Retry-After` override.
- Retention: F23/F23B/F24/F24B/F25, and the F44 clock-jump guard.
- Reconcile floor pinning (F38) and the reconcile ceiling (F39) as pure state-machine tests.
- `SyncStore` **contract tests run against both backends** (`store-memory`, `store-sqlite`),
  including the S1 lost-update sequence (F37) and `clearRecords` clearing the body queue (F35).
- **Format marker (V4):** a mismatched, stale, or absent marker triggers
  `purgeAccount('store-format-change')` at launch *before* any cycle; a crash between materialising a
  store and writing its marker leaves a mismatch (safe), not a false match (§8.4.1).

**Integration against a real Stalwart.** Note the honest cost (S16): the docker-compose
`integration/` fixture with alice/bob/carol lives in the **sibling `vncmail-plus` repo**, not this
one. "Reuse it" means either a cross-repo checkout in this repo's CI or lifting the compose file
here — a real setup cost to budget, not a free reuse. Cases:
- Bootstrap → deliver mail *during* the coverage scan → assert the first delta cycle picks it up. The
  §4.1 ordering test, and the highest-value test in the list.
- Multi-page drain with `maxChanges` forced to 2; `SIGKILL` between pages; relaunch; assert
  convergence with no duplicates or omissions (F1).
- Flag toggle from a second client → assert the local envelope's `keywords` update and **no body
  refetch occurs** (a network assertion, not just a state assertion — D1/§5.3).
- Mailbox delete with `onDestroyRemoveEmails` both true and false (F7).
- Force `cannotCalculateChanges` (stale `sinceState`) → assert reconcile runs, records stay readable
  throughout, delta keeps flowing during the enumeration (F49), and the sweep deletes exactly the
  server-absent ids (F9).
- **Widen retention mid-reconcile** → assert nothing in the gap is deleted and the widen is applied
  after the sweep (F38). This is the test for the design's worst potential data-loss bug.
- Airplane-mode read path + two-account isolation (skill step 8's smoke test), plus an explicit
  regression for D6: switch accounts mid-fetch, assert no row lands under the wrong account.
- Purge: kill mid-purge, relaunch, assert no records and no surviving cursor (F4/F22).

**Property/fuzz (cheap, high yield):** generate random legal change pages (with §5.4's permitted
overlaps) and random kill points; assert the local store converges to the same state as a
from-scratch bootstrap. This is what finds ordering bugs no hand-written case will.

---

## 14. Rollout and migration

1. **Discard, don't migrate.** On first run, delete the `webmail:offline-cache:{index,entry}:v2:*`
   namespace and bootstrap fresh. The old cache is unencrypted JSON with stale keywords (D1) and no
   cursor; one sync rebuilds it. Migrating would mean trusting records whose provenance we can't
   establish.
2. **Feature flag** `offlineSyncEngineV2` in `settings-store`, default off, so the old path stays
   available during dogfood. The flag gates trigger registration in `App.tsx`, not just the engine
   body, so the two can never run concurrently.
3. **Order of work — revised per S4.** SQLite comes *before* the engine:
   1. **Plain `expo-sqlite`** (no SQLCipher): the §9.3 schema, `store-sqlite.ts`, `store-memory.ts`,
      the format marker (§8.4.1), and the `SyncStore` contract tests that run against both backends.
      This is the part of skill step 6 that does not need the step-7 key decision, and it keeps Expo
      Go working (manual §4: only `useSQLCipher` is incompatible).
      **First task in this sub-step, before any schema work: confirm that claim empirically** —
      `expo-sqlite` is not yet a dependency here, so add it and open a database in Expo Go on a real
      device. §9.2's V4 note explains what changes if the answer is no.
   2. `apply.ts` + `overlay.ts` + `errors.ts` + `states.ts`, fully unit-tested with no engine.
   3. Cursors and the delta drain (jobs A1/A2).
   4. Coverage (job B) and the bootstrap sequence.
   5. Bodies (C1, C2).
   6. Triggers, then UI.
   7. **Later, separately:** flip `useSQLCipher` once step 7's key-lifecycle decision is signed off.
      Because §14.1 already discards and rebuilds, the file-format change is a purge +
      re-bootstrap, not a migration.

   Two consequences to record, since this reorders the skill: it moves *part* of step 6 ahead of
   step 5 (the human should note this in the skill's status log), and it makes step 6's remaining
   work the encryption flip alone. In exchange, D3 is actually fixed, S1's atomicity becomes a real
   transaction rather than a discipline, and there is no throwaway AsyncStorage backend.

   The Android emulator smoke gate (`.github/workflows/android-emulator-smoke.yml`) must stay green
   at every sub-step.
4. **If step 3.1 stalls**, §9.2's contingency applies: an AsyncStorage backend with its limits
   stated, D3 left open, and the per-account mutex load-bearing.

---

## 15. Summary of key decisions

1. **Three state machines** — delta cursor, envelope coverage, bodies (queue **plus** backfill) —
   each with its own persisted state, **but serialised within an account (I11)**, not concurrent.
   The separation is what lets the cursor advance while bodies lag; the serialisation is what keeps
   it safe.
2. **Bootstrap: replace the code, keep the shape.** Still a query-driven bulk scan, because
   `/changes` cannot deliver pre-existing mail — but rewritten, because `runOfflineSync` captures no
   cursor, can't page stably, can't resume, and fetches at the wrong granularity.
3. **Capture cursors *before* enumerating** (§4.1). Errs toward re-delivery, never toward gaps.
4. **An `updated` Email costs a 3-property fetch, never a body**, and is a **no-op when the record is
   absent**. RFC 8621 §4.1. Largest efficiency win, and it fixes the shipped bug where offline
   read/unread state is permanently wrong (D1).
5. **Cursor-last, always** (I1). A crash re-delivers a page; it never skips one. Under SQLite this is
   a real transaction.
6. **Cursor provenance is an ordering rule with type-level teeth** (I2, §3.2). A `Foo/changes`
   `newState` advances a cursor; a `Foo/get` `state` may seed one *only* inside an
   `EnumerationCommitment`. Revision 1's "only a changes state, ever" was false — the design's own
   bootstrap violated it — and a rule the design violates is a rule that gets bypassed exactly where
   it matters (D4).
7. **Failure means the cursor stands still.** One error class of seven moves it, and its action is a
   verified rebuild.
8. **`cannotCalculateChanges` is handled as mandated, without blanking the UI, with a pinned sweep
   floor, and without stalling delta sync** (§7.6). The floor pinning (S2) is what stops a
   mid-reconcile retention widen from permanently deleting mail; going live at seed time (S9) is what
   stops a wide-window rebuild from blocking incoming mail for hours.
9. **No error path can wedge an account** (I10). Per-cursor counters (S6) so one healthy cursor can't
   mask another's wedge, a **monotonically shrinking** `maxChanges` ladder (S7), a confirmed
   `oldState` mismatch before escalating plus a reconcile ceiling (S10).
10. **Records are never deleted by inference** (I7): only `destroyed`, retention, the pinned sweep, or
    purge. Hence no email→mailbox FK and no cascade.
11. **Everything is keyed by account — including the SQL primary keys** (S3). JMAP ids are unique
    only within an account, and no sync state lives in a global key, so step 6's per-account wipe
    removes cursors and records together.
12. **Local mutations are a read-time overlay, not a write-through** (S11). The durable store holds
    server truth only; the outbox stays the single durable record of intent. This deletes the
    atomicity requirement rather than guarding it — **but it makes the outbox's own durability
    load-bearing, and today it is fire-and-forget, so §5.6.1 requires fixing that first** (V1).
    Unread badge counts and SQL `keywords` predicates are explicitly *not* overlaid (§5.6.2).
13. **Single-flight with coalescing, never abort-to-serve** (D7), **plus a resume trigger for
    unfinished work** with progress-gated chaining (S8).
14. **Push is a wake signal, not a cursor.** Mobile will consume the same JMAP WebSocket as Electron
    — foreground only, behind `onStateChange(StateChange)`; background stays on the relay.
15. **SQLite ships before the engine** (S4), plain first and encrypted later — which fixes D3 for
    real, makes S1's atomicity a database property, and defers the human-gated key decision. The
    encryption flip has a defined trigger: an out-of-band store-format marker in the registry, since
    `schemaVersion` lives inside the file the flip makes unreadable (§8.4.1, V4). **The "plain
    `expo-sqlite` works in Expo Go" premise is untested and is step 3.1's first task** (V4).
16. **Disabling offline caching purges** that account's store (S13), and a disabled account's store is
    never materialised at all (§9.5).

**On two fixes implemented differently from the review's suggestion**, both by removing the failure
mode rather than guarding it: S11 (read-time overlay instead of an atomic write-through — no
cross-store transaction needed, and the "delta reverts a local change" mode ceases to exist) and
S7's third rung (dropped rather than reordered, since the RFC ambiguity that justified it could not
be substantiated by either the reviewer or me). Neither weakens the property the finding was
protecting.

### Open questions for the human

1. **Concrete retention defaults.** The split into `offlineEnvelopeDays` / `offlineBodyDays` and the
   decision that envelopes ≫ bodies are settled; the *numbers* are not recorded anywhere this pass
   could read. Two constants in `settings-store.ts`; the design is value-independent.
2. **`offlineCacheEnabled` default.** Recorded as **staying `false`** per the earlier decision, and
   §9.5 now guarantees a disabled account materialises nothing. Flagged only because §8.4's
   purge-on-disable makes the toggle destructive, so its Settings copy needs to say so.
3. **The skill's step order.** §14.3 moves plain `expo-sqlite` (part of step 6) ahead of step 5.
   Worth a line in the `VNCprodbuild` status log so the next session doesn't re-derive it.

None blocks implementation.

---

## 16. Note: `android/` vs. Continuous Native Generation (review Part 4)

Flagged, deliberately **not resolved here** — this is a program-level decision, not a sync-design
one, and it predates this document.

The manual's §4 decision was to stay Continuous Native Generation (don't commit `ios`/`android`, let
`expo prebuild` regenerate them). In this repo that has already been broken: `.gitignore` ignores
only `/ios`, and `android/` is tracked and contains hand-written Kotlin (FCM push modules, a
client-cert module, notification-tap storage) that no Expo config plugin generates, plus
`google-services.json` and a debug keystore. `expo prebuild --clean` — which step 6's `useSQLCipher`
plugin needs — would destroy all of it.

This design does not create the conflict and does not depend on how it is resolved; it will collide
with it at §14.3's step 3.7 (the SQLCipher flip), **not** at step 3.1, since plain `expo-sqlite`
needs no config-plugin prebuild. The two options for the human at that point: port the Kotlin
modules into a local Expo config plugin (restoring real CNG), or formally abandon CNG for Android and
accept hand-maintained native there. Also worth recording then: `app.config.js`'s
`ios.config.usesNonExemptEncryption: false` must flip once SQLCipher ships in the iOS binary (skill
step 13).
