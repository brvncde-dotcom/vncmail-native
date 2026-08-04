# JMAP Delta-Sync Engine — Design

Status: **design only, not implemented.** Produced for `VNCprodbuild` Phase 2 step 5
(`[AI, L]`). Per that step, this document must pass an independent, fresh-context adversarial
review *before* any implementation begins. Nothing in `src/` was changed by the pass that wrote
this file.

Author pass: 2026-08-04. Repo: `brvncde-dotcom/vncmail-native`, branch `claude/delta-sync-design`.

Companion documents:
- `~/.claude/skills/VNCprodbuild/SKILL.md` — the build plan; this is step 5 of Phase 2.
- `~/worktrees/vncmail-electron/docs/VNCMAIL-NATIVE-BUILD-MANUAL.md` — program narrative;
  §4 decision log (multi-account isolation required; `expo-sqlite` + `useSQLCipher`; CNG),
  §6.1 (what this repo already has), §7 (remaining roadmap).

Normative references, cited by section throughout:
- **RFC 8620** (JMAP core) — §1.2 ids, §3.6.1 request-level errors, §3.6.2 method-level errors,
  §5.2 `Foo/changes`, §7.1 `StateChange`, §7.2 `PushSubscription`.
- **RFC 8621** (JMAP Mail) — §2.2 `Mailbox/changes` (incl. `updatedProperties`), §4.1 Email
  property mutability, §4.2 `Email/get`, §4.3 `Email/changes`, §4.5 `Email/queryChanges`.

---

## 0. Scope

**In scope (this design):** the mechanism that keeps a per-account local mail store in step with
the server using `Email/changes` and `Mailbox/changes`, including first-sync bootstrap, change
application, pagination, crash recovery, error/retry semantics, multi-account isolation, the
storage abstraction boundary, and triggering.

**Out of scope, deliberately:**
- The SQLCipher backend itself (skill step 6). This design defines the interface it plugs into.
- FTS5 index population (step 9) — but §9.4 reserves the hook.
- Offline compose/outbox (step 10) — already exists as `src/stores/outbox-store.ts`; §5.6
  defines how the engine interacts with it.
- Background task registration (`BGTaskScheduler`/`WorkManager`, step "platform hardening").
  §10.5 defines the constraint the engine must satisfy so that step is a wiring change.
- Calendar/Contacts/Files delta sync. Same engine shape would apply; not designed here.
- Shared/group (Stalwart "group account") mail. §8.2 makes this a data-model no-op to add later.

**Non-goal:** bit-for-bit compatibility with today's cache. §14 specifies a discard-and-rebuild
migration; there is no reason to migrate an unencrypted JSON cache that a single sync can rebuild.

---

## 1. What exists today, verified

Read before designing; file:line references are to `claude/delta-sync-design` at time of writing.

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

UI surfaces: `src/components/OfflineCacheBanner.tsx` (phase/progress banner),
`src/components/settings/AboutDataSettings.tsx` (stats, manual "Sync now", clear).
Triggers: `App.tsx:277-284` (2s after a live session appears, re-fires when the days/MB
settings change). Settings: `offlineCacheEnabled/Days/MaxMB` (`settings-store.ts:222-226`,
defaults `false / 7 / 50`).

### 1.2 What already exists and should be reused

The repo is **further along than the manual implies**. `src/api/email.ts` already has
`/changes` wrappers, and `src/stores/email-store.ts` already drives an incremental path for the
*visible list*:

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

The engine designed here is **not** a replacement for the email-store's list-level
`queryChanges` path — that path exists to keep *one visible mailbox window* fresh and is
correct for that job. The engine owns the *durable local store*. §5.7 defines the boundary.

### 1.3 Defects found in the existing code (must not be inherited)

These are the reasons "just add `Email/changes` to `offline-sync.ts`" is not the answer. Each is
a real, reproducible gap, listed so the reviewer can check the new design closes it.

- **D1 — cached envelopes go permanently stale.** `offline-sync.ts:77` skips any id already in
  the index, with the comment "bodies on disk are immutable per messageId". Bodies are indeed
  immutable (RFC 8621 §4.1), but `keywords` and `mailboxIds` are the two mutable properties, and
  they are stored in the same blob. A message cached while unread stays unread in the offline
  list forever unless the user happens to open it online (`email-store.ts:1044-1050`) or a local
  mutation patches it (`offline-cache-store.ts:210-223`). Read/unread state read offline is
  simply wrong. *Closed by §5.3 (Email `updated` → 3-property refresh).*
- **D2 — storage write failures are swallowed.** `persistIndex()`
  (`offline-cache-store.ts:97-101`) is fire-and-forget with a `console.warn`. An index write that
  fails leaves entry blobs on disk that nothing references (leak), or — in the new
  cursor-carrying world — would let a cursor advance over data that was never durably written.
  *Closed by I4 and §9.2 (storage errors must reject, never warn-and-continue).*
- **D3 — every folder open is an O(cache) scan.** `getEmailsInMailbox()`
  (`offline-cache-store.ts:275-301`) reads and JSON-parses *every* cached entry to test
  `email.mailboxIds[mailboxId]`, because the index doesn't carry mailbox membership. At the
  50 MB cap that is thousands of AsyncStorage reads on the offline path. *Closed by §9.3's
  schema (indexed envelope table + `email_mailbox` membership rows).*
- **D4 — a cursor can advance to the wrong state token.** `email-store.ts:885-889` writes
  `nextEmailState ?? fetchState ?? emailState`, where `fetchState` is the `state` from an
  `Email/get` (`email-store.ts:849-851`). Two problems: (a) an `Email/get` `state` is a *later*
  snapshot than the `Email/changes` page just applied, so adopting it silently skips every
  change in between; (b) when `getEmailChanges` returns `null` (line 831-835 treats that as
  `cannotCalculateChanges`), the code clears `nextEmailState` and then falls back to
  `fetchState`, adopting a fresh cursor **without** doing the full resync RFC 8620 §5.2 mandates.
  Blast radius today is limited to the visible list, but the identical pattern in a durable store
  is silent, permanent data loss. *Closed by I2 (only `Foo/changes.newState` advances a cursor)
  and §7.5.*
- **D5 — all method-level errors collapse to `null`.** `getEmailChanges`
  (`email.ts:366-367`) and `getMailboxChanges` (`email.ts:144-145`) return `null` for *any*
  `error` response. So `cannotCalculateChanges` (→ full resync mandated),
  `serverUnavailable` (→ retry later), `tooManyRequests`/rate limiting (→ back off), and
  `invalidArguments` (→ our bug) are indistinguishable. Under today's code that mostly costs a
  wasted refetch; under a cursor-carrying engine it means a transient 503 triggers a full resync,
  or worse, is mistaken for a state invalidation. *Closed by §12.1 (typed error results).*
- **D6 — `runOfflineSync` has no local-account guard.** `queryEmailsByFilter`
  (`email.ts:733-747`) resolves `jmapClient.accountId` at call time. `offline-cache-store`'s
  `put()` re-checks `activeAccountId` before stamping the index (`:195`), so data doesn't land in
  the wrong bucket — but the *fetch* follows whatever account the client now serves, so after a
  mid-sync account switch the run silently downloads account B's mail and throws it away, while
  reporting progress against account A. *Closed by §8.3 (epoch-guarded cycles).*
- **D7 — "sync again" cancels instead of syncing.** `offline-sync.ts:41-44`: if a run is in
  flight, the new call sets the abort flag and returns. A user who taps "Sync now" during a sync
  gets a *cancelled* sync and no new one. *Closed by §10.3 (single-flight with coalescing).*
- **D8 — unstable pagination is latent.** Today there is no paging at all (one 5000-id query),
  so the bug can't fire; but the obvious fix ("add `position`") would introduce it. See §6.2.

---

## 2. Architecture

Three **independent, separately-persisted** state machines per account. Keeping them separate is
the central structural decision of this design: it is what lets the cursor advance while bodies
lag, lets a retention change not look like a resync, and lets a crash lose at most one unit of
work in each.

```
                         ┌───────────────────────────────┐
   triggers (§10) ──────▶│  SyncEngine.runCycle(account) │
                         └───────────────┬───────────────┘
                                         │ single-flight per account
             ┌───────────────────────────┼───────────────────────────┐
             ▼                           ▼                           ▼
   ┌───────────────────┐      ┌────────────────────┐      ┌────────────────────┐
   │ A. DELTA          │      │ B. COVERAGE        │      │ C. BODIES          │
   │ Mailbox/changes   │      │ historical backfill│      │ drain body_queue   │
   │ Email/changes     │      │ (Email/query scan) │      │ Email/get full     │
   │ state: cursors    │      │ state: coverage    │      │ state: body_queue  │
   └───────────────────┘      └────────────────────┘      └────────────────────┘
             │                           │                           │
             └───────────────────────────┴───────────────────────────┘
                                         ▼
                              ┌─────────────────────┐
                              │  SyncStore  (§9)    │  ← AsyncStorage now,
                              │  per-account        │    SQLCipher at step 6
                              └─────────────────────┘
```

**A. Delta** is the steady state: drain `Mailbox/changes`, then `Email/changes`, page by page,
advancing the cursor once per fully-applied page. Cheap: `updated` emails cost a 3-property
`Email/get`; `destroyed` costs nothing.

**B. Coverage** owns *history*. The delta stream only reports what changed since a cursor; it
never delivers mail that already existed when the cursor was created. Coverage is the job that
walks backwards to fill the retention window, and the job that runs when the user widens
"keep 7 days" to "keep 30 days". It is also the *bootstrap* (§4).

**C. Bodies** owns the expensive part. `created` emails enter A's path as envelopes only; a
durable queue then fetches bodies at low priority. A failed or slow body fetch can therefore
never hold back the cursor, and a kill mid-download costs one batch.

### 2.1 Two record tiers

| Tier | Properties | Who writes it | Retention |
|---|---|---|---|
| **Envelope** | `EMAIL_LIST_PROPERTIES` (`email.ts:6-9`) — id, threadId, mailboxIds, keywords, size, receivedAt, from, to, cc, subject, preview, hasAttachment | A (delta) and B (coverage) | the *envelope window* |
| **Body** | `bodyStructure, textBody, htmlBody, bodyValues, attachments, blobId, bcc, replyTo, sentAt` | C (bodies) | the *body window*, subject to the MB cap |

Rationale: envelopes are ~1 KB and are what the offline list, the FTS index (step 9), and the
"is this message still in scope" retention decision all need. Bodies are ~10–500 KB and are only
needed when a message is actually opened. Today's cache conflates them, which is why the 50 MB
cap translates to only a few hundred messages being visible offline at all.

**Decision:** envelope window = body window = `offlineCacheDays` in v1, so user-visible behaviour
doesn't change on day one; the MB cap applies to bodies only. The tiers are separate in the
schema and in the retention policy so a later "envelopes: 1 year, bodies: 30 days" setting is a
policy change, not a redesign.

### 2.2 Module layout (for the implementer, not built here)

```
src/sync/
  engine.ts        orchestration: triggers, single-flight, cycle budget, phase reporting
  cursor.ts        cursor state machine + the advance rules of §7.5
  apply.ts         PURE change application: (localState, changesPage, fetched) -> mutations
  coverage.ts      job B
  bodies.ts        job C
  retention.ts     window + MB cap policy, eviction
  errors.ts        classify() and the taxonomy of §7.1
  store.ts         SyncStore interface (§9) + AsyncStorageSyncStore (v1 backend)
  store-sqlite.ts  step 6, not now
src/stores/
  sync-status-store.ts   UI-facing status; supersedes the sync fields of offline-cache-store
```

`apply.ts` being pure (no network, no storage, no Zustand) is a hard requirement: every rule in
§5, §6.3 and §11 must be unit-testable without a JMAP server or a device. That is the only way
the failure-mode table below becomes a test suite rather than a promise.

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
  /** The `newState` of the last FULLY APPLIED /changes page. Never any other token. */
  state: string;
  /** True when the last page reported hasMoreChanges — a drain is unfinished. */
  drainPending: boolean;
  /** Set when the server invalidated us (cannotCalculateChanges / protocol violation). */
  invalidatedAt?: number;
  invalidatedReason?: 'cannotCalculateChanges' | 'oldStateMismatch' | 'manual';
  updatedAt: number;
}

interface CoverageState {
  jmapAccountId: JmapAccountId;
  /** ISO. Oldest receivedAt for which the envelope tier is known-complete. */
  coveredFrom: string | null;
  /** ISO. Newest receivedAt reached by the initial scan; null once bootstrap is done. */
  scanCursor: string | null;
  /** The retention floor the scan is currently working toward (windowStart). */
  targetFrom: string;
  phase: 'never-run' | 'scanning' | 'complete';
  /** Progress, for the UI only. Never load-bearing. */
  seen: number;
  updatedAt: number;
}

interface BodyQueueEntry {
  emailId: string;
  jmapAccountId: JmapAccountId;
  receivedAt: string;   // drives priority: newest first
  attempts: number;
  lastError?: string;
  nextAttemptAt?: number;
}

interface AccountSyncState {
  /** Bumped on every login/logout/purge for this account. Guards late writes (§8.3). */
  epoch: number;
  schemaVersion: number;
  cursors: SyncCursor[];          // keyed by (type, jmapAccountId)
  coverage: CoverageState[];      // keyed by jmapAccountId
  /** Set when a resync is owed but not yet finished. Data stays readable meanwhile (§7.6). */
  resyncRequired: boolean;
  lastCycle?: {
    startedAt: number; finishedAt?: number;
    outcome: 'ok' | 'partial' | 'failed' | 'abandoned';
    error?: string;
  };
  consecutiveFailures: number;
  /** sinceState that failed last cycle; used by the anti-wedge escalation (§7.7). */
  lastFailedState?: string;
}
```

Cursors are keyed by `(LocalAccountId, JmapAccountId, CursorType)`. **All three components are
required.** `LocalAccountId` because the device can hold up to 5 accounts
(`account-utils.ts:MAX_ACCOUNTS`). `JmapAccountId` because one JMAP session exposes the user's
own account plus every shared/group account, and each carries its own independent state token —
this is exactly why `email-store.ts:101-121` already keys `emailStates` this way. `CursorType`
because RFC 8620 §5.2 state tokens are per-datatype: an Email state and a Mailbox state are
different namespaces and are never interchangeable.

### 3.2 What is deliberately *not* a cursor

- **`Email/get`'s `state`.** A later snapshot than the page we just applied; adopting it skips
  changes (defect D4). Fetched values are used; the returned `state` is discarded.
- **`Email/query`'s `queryState`.** Belongs to a specific filter+sort. The engine's coverage job
  does not use `queryChanges`; the email-store's visible-list path owns `queryState` and keeps
  it in its own store (`email-store.ts:169-173`). The two must not be mixed.
- **The `newState` inside a pushed `StateChange`.** It is a *target*, not a starting point. Using
  it as `sinceState` would skip everything between our cursor and it. See §10.4.
- **`sessionState`.** Session-level; signals capability/account-set change (§11 F19), not data
  change.
- **Thread state.** v1 keeps no local Thread table; `threadId` on the envelope is enough for
  local grouping. No `Thread/changes` cursor.
- **`EmailDelivery`.** A push type only (RFC 8620 §7.1 / `push-notifications.ts:103`); there is
  no `EmailDelivery/changes`. Wake signal only.

### 3.3 Invariants

The design's correctness reduces to these. Every rule in §5–§8 exists to hold one of them, and
the failure-mode table in §11 is the enumeration of attempts to break them.

- **I1 — cursor-last.** A cursor is written only *after* every record mutation implied by its
  page is durable. Consequence: a crash re-delivers a page (at-least-once), never skips one.
- **I2 — provenance.** A cursor's value is only ever a `newState` returned by the same
  `Foo/changes` method for the same `(jmapAccountId, type)`. No other token, ever (closes D4).
- **I3 — monotonic or invalidated.** A cursor moves forward through applied pages, or is
  explicitly invalidated and rebuilt (§7.6). It is never cleared silently, and never rolled back.
- **I4 — no silent write loss.** Every storage write either succeeds or raises. A failed write
  fails the cycle (closes D2).
- **I5 — idempotent application.** Applying the same page twice yields the same local state.
  Guaranteed by upsert-by-id + delete-if-exists, and by RFC 8620 §1.2 ids never being reused.
- **I6 — account containment.** Every read and write is namespaced by `LocalAccountId`; every
  commit re-checks `(accountId, epoch)` before landing (closes D6).
- **I7 — deletion provenance.** A local email record is deleted only by (a) `Email/changes`
  `destroyed`, (b) retention eviction, (c) the reconciliation sweep of §7.6, or (d) account
  purge. Never by inference from mailbox state (§5.5).
- **I8 — no clock dependence.** No correctness property depends on the device clock. Server
  `receivedAt` values order the store; the device clock only picks the retention window boundary
  and backoff delays.
- **I9 — bounded work.** Every loop (page drain, coverage scan, body queue) has an explicit
  budget and terminates. No unbounded `while (hasMoreChanges)`.
- **I10 — no wedge.** No error path can leave an account permanently unable to make progress.
  Repeated non-transient failure escalates to resync (§7.7), which is always achievable from a
  cold start.

---

## 4. Bootstrap vs. steady state — the decision

**Asked explicitly by the brief:** reuse `offline-sync.ts`'s bulk download for the initial sync
and switch to `/changes` afterward, or replace it entirely?

**Decision: replace the code, keep the shape.** The bootstrap remains a query-driven bulk scan —
that is the right mechanism, because `/changes` structurally cannot deliver pre-existing mail —
but it is rewritten as job B (`coverage.ts`) rather than reusing `runOfflineSync`. Three
defects make the existing function unusable as-is, and all three are in the load-bearing part:

1. **No cursor capture.** `runOfflineSync` never obtains a state token. If it were followed by a
   first `Email/changes` call, that call would need a `sinceState` taken *after* the scan
   finished — and every change that happened *during* the scan (minutes, on a large mailbox)
   would fall in the gap: not in the scan's result set, not in the change stream. Permanent,
   silent hole. This is the classic snapshot-isolation bug and it is not fixable by adding a
   line; it dictates the order of operations (§4.1).
2. **Unstable, unresumable paging.** One 5000-id query with no paging. The obvious extension
   (`position`) is wrong under concurrent change (§6.2), and neither form can resume after the
   OS kills the app mid-scan — the next launch restarts from zero.
3. **Wrong granularity.** It fetches full bodies for everything up front, so the MB cap
   determines how many messages exist offline *at all*. With the tiering of §2.1 the envelope
   scan is ~1 KB/message and the body fetch is a separate, evictable pass.

What is kept from it, deliberately: the `{days, maxMB}` policy shape, the chunk-to-
`maxObjectsInGet` batching, the progress-to-store reporting that `OfflineCacheBanner` renders,
and oldest-first eviction. Those are all fine.

### 4.1 Bootstrap sequence (mandatory order)

```
1. CAPTURE CURSORS FIRST, in one JMAP request, before touching any data:
     ['Mailbox/get', {accountId, ids: []}, '0']     -> mailboxState
     ['Email/get',   {accountId, ids: []}, '1']     -> emailState
   Persist both as cursors with drainPending=false.
   (Email/get with ids:[] returning a usable state token is already relied on by
   getEmailsWithState(); email.ts:329-336.)

2. Full Mailbox/get -> upsert every mailbox row. Cheap, always complete, no paging.

3. Coverage scan (§6.1): ascending keyset walk over the envelope window,
   committing after each page and advancing CoverageState.scanCursor.

4. Mark coverage.phase = 'complete', coveredFrom = targetFrom.

5. Run a normal delta cycle. It replays everything that changed during steps 2-4.
```

Step 1 preceding step 3 is the whole point: the cursor is *older* than the data, so the first
delta cycle re-delivers some changes we already have. That is I5 doing its job — a handful of
redundant upserts is the correct price for a structurally gap-free handoff. The opposite order
(scan, then capture) is cheaper and silently loses mail; it must not be "optimised" back in.

Corollary for the reviewer: the engine must be able to serve reads during steps 2–4. The UI shows
partial coverage (`OfflineCacheBanner` progress) and the offline list simply has less history
than it eventually will. There is no "sync in progress, no data" state.

---

## 5. Change application: order and consistency

### 5.1 Order within a cycle

```
1. Mailbox/changes  — drained fully (or to budget) before Email/changes.
2. Email/changes    — drained page by page.
3. Bodies           — queue drain, lowest priority, may be cut by the cycle budget.
```

Mailbox first because folder rows are what the list UI resolves names and roles against, and
because a `created` mailbox should exist locally before envelopes referencing it land. This is
an ordering *preference*, not a correctness dependency — see §5.5 and §9.3: the schema must not
enforce a foreign key from email→mailbox, because the two change streams are not transactionally
coupled and either order can be observed. A design that needs the FK is a design that breaks the
first time a message arrives in a mailbox we haven't fetched yet.

### 5.2 `Mailbox/changes` application

| Result | Action |
|---|---|
| `created` | `Mailbox/get` full object → upsert row. |
| `updated`, `updatedProperties` non-null and ⊆ {`totalEmails`,`unreadEmails`,`totalThreads`,`unreadThreads`} | `Mailbox/get {properties: updatedProperties}` → patch only those columns. |
| `updated`, `updatedProperties` null | `Mailbox/get` full object → upsert row. |
| `destroyed` | Delete the mailbox row **only**. Do not touch email records (I7). |

The `updatedProperties` optimisation is RFC 8621 §2.2: *"If only the `totalEmails`,
`unreadEmails`, `totalThreads`, and/or `unreadThreads` Mailbox properties have changed since the
old state, this will be the list of properties that may have changed"*, and *"If the server is
unable to tell whether only counts have changed, it MUST just be null."* Counts change on every
delivery and every read, so on a busy account this is the difference between patching four
integers and re-fetching every folder object repeatedly. Note the wording is "may have changed" —
so the returned list is an upper bound, and patching exactly those columns is correct.

`MailboxChangesResult` (`email.ts:125-132`) does not currently surface `updatedProperties`;
§12.1 adds it.

### 5.3 `Email/changes` application — the important one

The brief asks what must be re-fetched on an `updated` id versus inferred. The answer is fixed
by RFC 8621 §4.1: **`keywords` and `mailboxIds` are the only mutable Email properties.**
Everything else — body structure, body values, attachments, headers, `receivedAt`, `size`,
`threadId`, `preview`, `subject`, addresses, `hasAttachment` — is immutable for the lifetime of
the id. An `updated` Email therefore *cannot* have a changed body, and re-fetching one is pure
waste.

| Result | Fetch | Notes |
|---|---|---|
| `created` | `Email/get {properties: EMAIL_LIST_PROPERTIES}` | Envelope tier. Enqueue into `body_queue` **iff** in the body window. Never fetch bodies inline. |
| `updated` | `Email/get {properties: ['id','keywords','mailboxIds']}` | 3 properties. Never bodies. Patch in place; the existing body blob stays valid. |
| `destroyed` | nothing | Delete envelope + body + membership rows + any `body_queue` entry. |

There is no `updatedProperties` on `Email/changes` (RFC 8621 §4.3 is a plain `/changes` method),
so a fetch is unavoidable for `updated` — but a 3-property one, batched to `maxObjectsInGet`.
This single rule is the largest efficiency difference from today, and closes D1: cached
read/unread and folder membership now actually track the server.

Batching: `created` and `updated` ids from a page are fetched in **two separate**
`Email/get` calls (different `properties` sets), each chunked to
`min(maxObjectsInGet, 200)`. Both may be packed into one JMAP request when within
`maxCallsInRequest` (`jmap-client.ts:462-467`).

`notFound`: an id in `created`/`updated` that `Email/get` omits was destroyed between the two
calls. This is normal, not an error: skip the id, do not retry, do not fail the page. A
subsequent page (or cycle) will carry the `destroyed` entry; if it never does, the record was
never stored, so there is nothing inconsistent.

### 5.4 Ordering within one page

RFC 8620 §5.2 permits overlap between the arrays: *"If a record has been created AND updated
since the old state, the server SHOULD just return the id in the `created` list but MAY return it
in the `updated` list as well"*, and the same for updated+destroyed → `destroyed`. Created+
destroyed *"SHOULD"* be omitted entirely but is not forbidden.

**Rule: within a page, apply creates, then updates, then destroys.** Because ids are never
reused (RFC 8620 §1.2 — *"All record ids are assigned by the server and are immutable"*), a
destroy always refers to the same record as any create/update of that id in the same page, so
destroy-last converges on the correct final state (gone). The reverse order would resurrect a
dead id, spend a fetch on it, and get `notFound`.

**Pages are applied strictly in order, and a page is applied exactly once before its cursor is
written.** An id created in page 1 and destroyed in page 3 must be seen in that sequence; there
is no reordering, batching across pages, or parallel page application.

### 5.5 Mailbox/Email interaction

The two streams are independent, so transiently inconsistent local states are normal and must be
tolerated rather than repaired:

- **Envelope references a mailbox row we don't have** (email applied before its mailbox): keep
  the membership row. The folder simply doesn't appear in the sidebar until `Mailbox/changes`
  catches up, at which point the messages are already there. No FK, no cascade (§9.3).
- **Mailbox destroyed, its emails still local**: delete only the mailbox row (§5.2). If the
  server destroyed the messages too (JMAP `onDestroyRemoveEmails`), `Email/changes` will report
  them `destroyed` and I7's path (a) removes them. If the server moved them instead, their
  `mailboxIds` update arrives via `updated`. Either way the truth arrives on the Email stream.
- **A record whose `mailboxIds` becomes empty**: keep it. Do not infer deletion. It is reachable
  by id (notification tap, thread view) and will be reported `destroyed` if it truly is gone.
  Hiding it from folder listings falls out naturally — no membership rows, no listing hits.

This is I7 stated operationally: **email records are never deleted by inference.** The cost of
being wrong in that direction is a stale row that the next cycle cleans up. The cost of being
wrong in the other direction is a message the user cannot read while offline — which is the
exact failure this whole feature exists to prevent.

### 5.6 Interaction with the offline outbox

`outbox-store.ts` may hold unflushed local intent (`keywords` / `mailboxes` / `destroy`), all
expressed as **full-state assignments** and therefore idempotent by construction (that store's
own header documents this). Naively applying a server `updated` would visibly revert the user's
offline change.

**Rule:** after applying a delta to record `X`, if the outbox holds pending ops for
`(jmapAccountId, X)`, re-apply those ops' target state on top of the freshly-written server
state, in queue order. Server truth is the base; unflushed local intent is the overlay. When the
outbox later flushes, the server converges to the same value, and the resulting `Email/changes`
`updated` is then a no-op patch.

A pending `destroy` for `X` means the record is doomed: apply the server state, do not enqueue a
body fetch for it, and let the flush + subsequent `destroyed` remove it.

### 5.7 Boundary with `email-store`

They serve different consumers and must not share state:

| | Engine (this design) | `email-store` |
|---|---|---|
| Owns | durable local store, envelope+body tiers, `Email/changes` + `Mailbox/changes` cursors | the visible mailbox window, `queryState`, `Email/queryChanges` |
| Scope | whole account (all mailboxes, retention window) | one mailbox, one page, current filter |
| Lifetime | survives restart, drives offline reads | in-memory + persisted view snapshot |

Direction of information flow is **engine → email-store only**: the engine notifies
"account X changed" and the email-store decides whether the visible list needs a refresh (it
already has `handleStateChange`, `email-store.ts:969-1003`). The engine never reads the
email-store's `queryState` or `emailStates`, and vice versa. Two independent cursors over the
same server data is intentional redundancy, not duplication to be factored away — they page
differently, invalidate differently, and one being wrong must not corrupt the other.

`selectMailbox`'s cache seeding (`email-store.ts:646-663`) and `refreshEmails`'s offline fallback
(`:941-961`) keep working, reading through the new `SyncStore` instead of
`offline-cache-store.getEmailsInMailbox` — with the indexed query of §9.3 replacing the O(n)
scan (D3).

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
-> commit: upsert envelopes, enqueue in-window bodies,
           set scanCursor = max(receivedAt) of the committed page
```

Ascending is the correct direction for a backfill: new mail arrives at the *tail*, so insertions
never shift rows the scan has already passed. `scanCursor` is a server-provided `receivedAt`
(I8), so it is a meaningful resume point after a kill — the next launch continues from the last
committed page rather than restarting (fixing bootstrap defect 2 in §4).

Ties on `receivedAt` are the only hazard: a filter of `{after: scanCursor}` is exclusive at the
boundary in some server implementations and inclusive in others, which risks either skipping a
tie-cluster member or looping on one. Mitigations, in order:
1. Dedupe by id on commit (upserts are free, I5), so re-delivery is harmless.
2. **No-forward-progress guard**: if a page's `max(receivedAt)` does not exceed the incoming
   `scanCursor` *and* every returned id is already stored, advance using the `anchor` /
   `anchorOffset` arguments of `Foo/query` (RFC 8620 §5.5, inherited by `Email/query`,
   RFC 8621 §4.4) from the last id of the page for one page, then resume keyset.
3. If the anchor is rejected (`anchorNotFound`), advance `scanCursor` by 1 ms and continue,
   recording a warning. A one-millisecond tie-cluster larger than 200 messages is a corrupt
   server, not a case to design for.

The UI-facing progress (`seen`) is best-effort and explicitly not load-bearing.

`DISCOVERY_LIMIT` (5000) is replaced by two real bounds: the retention window (`targetFrom`) and
a per-cycle page budget (§6.4). A hard id cap is the wrong control — it silently truncates
history with no record of where truncation happened.

### 6.2 Why not `position`-based paging

`Email/query {position: n}` over a mailbox that is receiving mail shifts every subsequent page by
the number of insertions ahead of it. With descending sort, one delivery between page 1 and
page 2 pushes one message from the boundary of page 1 into page 2's start — and one *out* of the
scan's reach entirely. That message is pre-existing relative to our cursor, so `Email/changes`
will never report it: it is a permanent hole in the local store with no signal that it exists.

This is the trap referenced as D8 — today's single unpaged query hides it; the natural "add
paging" fix introduces it. Keyset ascending is immune by construction.

### 6.3 Delta drain and mid-drain crash recovery (job A)

```
drain(type, jmapAccountId):
  budget = pagesRemaining()                          # I9
  loop:
    if budget-- <= 0: mark cursor.drainPending = true; return PARTIAL
    res = Foo/changes { accountId, sinceState: cursor.state, maxChanges: MAXC }

    if res is error:  -> §7 classification. Cursor unchanged. Return.
    if res.oldState != cursor.state:                  # protocol violation
        -> invalidate cursor, resyncRequired = true (§7.6). Return.

    apply(res)          # §5.3/§5.4; may commit records partially (§7.4)
    commit { records..., cursor.state = res.newState,
             cursor.drainPending = res.hasMoreChanges }   # cursor LAST (I1)

    if !res.hasMoreChanges: return OK
```

`MAXC = min(maxObjectsInGet, 500)`. Bounding `maxChanges` keeps a single page's fetch inside one
`Email/get` batch, so a page is a small, quickly-committable unit — which is precisely what makes
crash recovery cheap.

**Crash / OS-kill mid-drain.** By I1, the last durable cursor is the `newState` of the last
*fully applied* page. On next launch:

1. `AccountSyncState` loads; `cursor.drainPending === true` tells the engine a drain was cut
   short, so the next cycle is scheduled immediately rather than waiting for a trigger.
2. The interrupted page is re-requested with the same `sinceState` and re-applied. By I5 this is
   a no-op for everything that had already been written, and completes what hadn't.
3. Worst case cost: one page (≤500 ids of 3-property or envelope data) refetched.

RFC 8620 §5.2's intermediate-state guarantee is what makes this work: when `hasMoreChanges` is
true, the returned `newState` is a state the client may pass back as `sinceState` to continue.
So persisting intermediate states is sanctioned, not a trick — and it is the only reason
crash recovery costs one page instead of a whole resync.

Note `drainPending` is a hint, never a correctness input: an engine that ignored it would still
be correct, just lazier. Nothing branches on it except scheduling.

### 6.4 Budgets (I9)

| Bound | Foreground | Background (later) |
|---|---|---|
| Pages per cycle, per type | 40 | 8 |
| Wall clock per cycle | 90 s soft deadline, checked between pages | 25 s |
| Body queue items per cycle | 200 | 20 |
| Coverage pages per cycle | 25 | 5 |

Exceeding a budget is a **normal** outcome (`outcome: 'partial'`), not an error: cursor stands at
the last committed page, `drainPending` stays true, next trigger resumes. This is also the
answer to a server whose `hasMoreChanges` never goes false (§11 F14) — the loop cannot spin
forever, and it cannot wedge either, because progress is committed each page.

---

## 7. Errors, retry, and cursor-advance semantics

### 7.1 Taxonomy

JMAP reports failure at three layers, and the current client flattens all of them (D5, and
`jmap-client.ts:442-445` throwing a bare `Error` for any non-2xx). The engine needs them
distinct:

| Class | Examples | Retry | Cursor |
|---|---|---|---|
| **Transport** | offline, DNS, TLS, socket reset, timeout, RN `TypeError: Network request failed` | yes, backoff | unchanged |
| **RateLimit** | HTTP 429 + `Retry-After` (already `RateLimitError`, `jmap-client.ts:436-440`); request-level `urn:ietf:params:jmap:error:limit` with `limit: "rateLimit"` (RFC 8620 §3.6.1) | yes, honour `Retry-After`/backoff | unchanged |
| **ServerTransient** | HTTP 5xx; method-level `serverUnavailable`, `serverFail`, `serverPartialFail` (RFC 8620 §3.6.2) | yes, ≤2 attempts, then abandon cycle | unchanged |
| **RequestLimit** | `urn:ietf:params:jmap:error:limit` with `maxSizeRequest` / `maxCallsInRequest` / `maxObjectsInGet` overrun; method-level `requestTooLarge` | yes, once, with halved batch size | unchanged |
| **Auth** | HTTP 401 after the client's own refresh retry → `AuthenticationError` | no | unchanged |
| **Fatal** | `invalidArguments`, `unknownMethod`, `accountNotFound`, `accountNotSupportedByMethod`, `forbidden` | no | unchanged |
| **StateInvalid** | `cannotCalculateChanges`; `oldState !== sinceState` | no (goes to resync) | **invalidated** (§7.6) |

Note there is exactly one row in which the cursor moves on failure, and that row's action is a
full, verified rebuild. Everywhere else, **failure means the cursor stands still**, which is what
makes "a failure never causes silent data loss" a structural property rather than a hope.

`tooManyRequests` as a method-level error type is not in RFC 8620 §3.6.2's registry, but servers
do return non-standard method error types; `classify()` therefore has a default rule: **an
unrecognised method-level error type is ServerTransient, not Fatal and never StateInvalid.**
Guessing "transient" costs a retry and a delayed sync; guessing "state invalid" costs a full
resync; guessing "fatal" costs a stalled account. The cheapest wrong answer wins the default.

### 7.2 Backoff

Full-jitter exponential: `delay = random(0, min(cap, base * 2^attempt))`, `base = 1 s`,
`cap = 60 s` foreground / `15 min` background. Max 4 attempts per operation within a cycle, then
the cycle ends with `outcome: 'failed'` and `consecutiveFailures++`. A `Retry-After` value always
overrides the computed delay when larger. Cycle-level scheduling then follows §7.7.

Jitter matters here specifically because §10 has five independent triggers, up to five accounts,
and a network-recovery trigger that fires on every account simultaneously — the exact shape that
produces a synchronized retry stampede against one Stalwart instance.

### 7.3 Offline is not an error

If `network-store.online` is false, or `jmapClient` has no live session
(`auth-store` keeps `session: null` in the authenticated-but-offline state,
`auth-store.ts:502-514`), a cycle **does not start**: outcome `abandoned`, no
`consecutiveFailures` increment, no error surfaced to the UI (the existing `OfflineBanner`
already tells the user). Same for the app being backgrounded before a cycle begins.

### 7.4 Partial-failure semantics inside a page

The unit of atomicity is the *cursor*, not the *record set*:

- **Records may be committed partially.** If the `created` batch succeeds and the `updated` batch
  fails, the created envelopes stay written. They are correct data; discarding them would be
  wasted bandwidth. By I5 the replay overwrites them with identical values.
- **The cursor advances only when the entire page has been applied.** One failed batch → cursor
  unchanged → the whole page replays next cycle.
- **Body fetch failures never affect the cursor.** Job C is separate state (§2). A body that
  fails increments `BodyQueueEntry.attempts` and sets `nextAttemptAt` with the same backoff;
  after 5 attempts the entry is dropped and the message stays envelope-only (openable online,
  shows a "not downloaded" state offline). This is a degradation, not a data-loss: the envelope
  is intact and the id is known.
- **Storage write failure is fatal for the cycle** (I4). Cursor unchanged, `outcome: 'failed'`,
  error surfaced. Never warn-and-continue (D2).

### 7.5 Cursor-advance rules, stated as one list

Because this is the property the reviewer will attack hardest:

1. A cursor advances **only** to a `newState` returned by a `Foo/changes` response for the same
   `(jmapAccountId, type)` (I2).
2. It advances **only after** all record mutations from that page are durable (I1).
3. It advances **on an empty page** (`created`/`updated`/`destroyed` all empty, `newState`
   differing) — that is a legitimate no-op advance and skipping it would re-request forever.
4. It does **not** advance on any error class except StateInvalid, where it is invalidated and
   rebuilt (§7.6).
5. It does **not** advance from an `Email/get` / `Mailbox/get` `state`, from a `queryState`, or
   from a pushed `StateChange` value (§3.2).
6. It is **not cleared** by logout-of-another-account, retention changes, eviction, cache
   clearing from Settings (which clears *records*, and sets `resyncRequired` rather than nulling
   cursors), or a failed body fetch.
7. It is **destroyed only** with its account's namespace, on purge (§8.4).

### 7.6 StateInvalid: the mandated full resync, done without blanking the UI

RFC 8620 §5.2 on `cannotCalculateChanges`: *"the server cannot calculate the changes from the
state string given by the client… The client MUST invalidate its Foo cache."* This happens when
our state is older than the server's change log, or after server data loss / a store rebuild.
The design must handle it — this is the mandated path, not an edge case.

A literal reading ("delete everything, now") would empty a user's offline mail at the exact
moment they may be offline and depending on it. So:

```
onStateInvalid(jmapAccountId, type):
  cursor.invalidatedAt/Reason = ...            # cursor is no longer trusted or usable
  accountState.resyncRequired = true
  # records stay readable, marked stale in the UI. Nothing is trusted as CURRENT.

reconcile(jmapAccountId):                       # unconditional once resyncRequired
  1. capture fresh cursors (Mailbox/get ids:[], Email/get ids:[])   # BEFORE enumerating (§4.1)
  2. full Mailbox/get -> upsert; delete mailbox rows not returned
  3. ascending keyset enumeration of the whole envelope window, recording seen ids
     (same paging as §6.1, resumable via scanCursor)
  4. sweep:  delete every local email record with receivedAt >= windowStart
             that was NOT seen in step 3
             delete every local email record with receivedAt <  windowStart   # unverifiable
  5. resyncRequired = false; cursors go live; coverage.phase = 'complete'
```

The cache *is* invalidated in the sense the RFC requires — no local record is treated as current,
and every one is either re-verified or deleted before the account is considered in sync again.
What is deferred is only the *moment of deletion*, from the start of the rebuild to its end.
Consequences of that choice, stated so the reviewer can weigh them:

- **Deliberate:** a user who is offline when invalidation is detected keeps readable (stale) mail
  instead of an empty inbox. The engine cannot even *begin* the rebuild while offline, so
  literal-deletion would mean an indefinite blank.
- **Accepted cost:** between detection and completion, a message deleted server-side may still be
  visible locally. Bounded by the reconcile completing, surfaced by the stale marker, and no
  worse than the staleness the offline case already implies.
- **Not acceptable and therefore forbidden:** serving `Email/changes` from the invalidated
  cursor, or letting the reconcile be skipped because a cycle succeeded in the meantime.
  `resyncRequired` is sticky until step 5 and survives restarts.

Step 4's second clause matters: records older than the window can't be verified by an enumeration
that only covers the window, so they are deleted rather than kept on faith. Normally retention
has already evicted them.

An invalidation of either cursor type triggers reconcile for that JMAP account as a whole.
Splitting it (rebuild Email but keep the Mailbox cursor) is not worth the reasoning burden —
`Mailbox/get` is one cheap call.

### 7.7 Anti-wedge escalation (I10)

Cursor-never-advances-on-failure has one theoretical failure mode: a page that can never be
applied (a server that always 500s on one specific `sinceState`, a persistently oversized page,
a genuine server bug) would retry forever, and the account would silently stop syncing.

```
after a failed cycle with the same lastFailedState:
  consecutiveFailures++
  next attempt scheduled with the §7.2 backoff (cycle-level, cap 15 min)
  consecutiveFailures == 2  -> retry the page with maxChanges halved
  consecutiveFailures == 3  -> retry the page with maxChanges omitted entirely
                               (some servers reject bounded change calculation)
  consecutiveFailures >= 5  -> escalate: treat as StateInvalid (§7.6) and reconcile.
                               Log loudly; surface "re-syncing offline mail" in the UI.
```

Escalating to reconcile is always achievable, because reconcile only needs the same calls a cold
start needs. A stuck cursor is therefore self-healing within ~5 cycles, at the cost of one full
window rescan. `consecutiveFailures` resets to 0 on any cycle with outcome `ok` or `partial`.

The `maxChanges` ladder is there because `cannotCalculateChanges` from a *bounded* call is a
known ambiguity in the spec (a server may be unable to compute a limited change set while being
perfectly able to compute the full one), and burning a whole resync on that would be a poor
trade. Retry unbounded once before escalating.

---

## 8. Multi-account isolation

Confirmed requirement (manual §4: *"the mobile offline cache must isolate per-account, including
per-account SQLCipher keys later"*).

### 8.1 Namespacing

Every key derives from `LocalAccountId` (`username@host`, `account-utils.ts`):

```
vncmail:sync:v1:<accountId>:state          -> AccountSyncState (cursors, coverage, epoch, …)
vncmail:sync:v1:<accountId>:env:<emailId>  -> envelope record
vncmail:sync:v1:<accountId>:body:<emailId> -> body record
vncmail:sync:v1:<accountId>:mbox:<mboxId>  -> mailbox row
vncmail:sync:v1:<accountId>:idx            -> listing index (§9.3)
vncmail:sync:v1:<accountId>:bodyq          -> body queue
vncmail:sync:registry                      -> accountIds present + purge tombstones (§8.4)
```

**No sync state lives in a global key.** The registry holds only account ids and purge
tombstones — never a cursor, never a record. This is the forward-compatibility requirement that
makes step 6 work: when the backend becomes one SQLCipher database file per account, deleting the
key and the file removes *all* of that account's sync state atomically. A cursor in a shared blob
would survive the wipe and then be used against a freshly-empty store — advancing over changes
that would never be re-delivered. That is exactly the silent-data-loss shape to design out now.

`vncmail:` rather than reusing the upstream `webmail:` prefix, so the v2 caches
(`offline-cache-store.ts:16-17`) and the new store cannot alias, and so §14's migration can
delete the old namespace wholesale.

### 8.2 JMAP-level accounts within one login

Cursors carry `jmapAccountId` (§3.1). v1 syncs the **primary mail account only**: shared/group
accounts stay online-only, as they effectively are today (the email-store re-reads them in full,
`email-store.ts:594-600`). Because the key already exists in the schema, adding them later means
inserting rows, not migrating. What must *not* happen is a single "the account's Email state"
scalar — that is the shape that has to be migrated later, and it would be wrong the moment a
shared mailbox is synced.

### 8.3 Epoch guard for late writes

Every cycle captures `(accountId, epoch)` at start and re-checks before each commit; a mismatch
drops the commit and abandons the cycle. `epoch` increments on login, logout, account switch to
this account, and purge.

This closes D6 and generalises `jmapClientServesActiveAccount` (`email-store.ts:131-138`): the
engine additionally verifies that the `jmapClient` currently serves the account the cycle is for,
before *every* network call, not just at the start — the cycle is long-lived and `switchAccount`
can land in the middle of it.

### 8.4 Logout, account removal, and the future key wipe

Skill step 7 will require wipe-on-logout for the SQLCipher key. The cursor/state lifecycle must
already respect that boundary:

```
purgeAccount(accountId):
  1. registry: add { accountId, purgePending: true }         # durable intent, crash-safe
  2. epoch++ (in memory) -> every in-flight cycle's next commit is rejected
  3. [step 6 and later] delete the SQLCipher key from expo-secure-store
     -- FIRST, because it renders the data unreadable immediately even if the
        file delete fails or is interrupted
  4. delete all keys / the database file under the account namespace
  5. registry: remove the entry
```

- **Crash between 1 and 5:** next launch sees `purgePending` and completes the purge before any
  cycle starts. No half-purged account is ever synced against — a store missing arbitrary records
  but holding a live cursor is the worst possible state, and step 1 makes it unreachable.
- **Ordering 3 before 4** is the security property, not an optimisation: an interrupted purge must
  leave unreadable data, not readable data.
- **`logout()` of one of several accounts** (`auth-store.ts:286-334`) purges only that namespace.
  Other accounts' cursors are untouched — no shared state to disturb (§8.1).
- **`logoutAll()`** purges each namespace in turn, then clears the registry.
- **Re-login to a purged account** finds no state, so `coverage.phase === 'never-run'` and it
  bootstraps (§4). A stale cursor surviving a purge would be catastrophic and is prevented by
  §8.1 + step 4 covering the same namespace as step 1's tombstone.
- **`AuthenticationError` during a cycle** is *not* a purge signal (§7.1: Auth → cursor
  unchanged, cycle abandoned). Only the auth store's explicit logout path purges. A server
  hiccup returning 401 must never delete a user's offline mail.

---

## 9. Storage-interface boundary

The backend swap to `expo-sqlite` + `useSQLCipher` (step 6) must be a backend substitution, not a
sync-engine rewrite. The engine therefore talks only to `SyncStore`.

### 9.1 Interface sketch

```ts
/** One atomic unit of work. On AsyncStorage this is emulated (§9.2); on SQLite it is a real tx. */
export interface SyncTxn {
  upsertMailboxes(rows: MailboxRow[]): Promise<void>;
  patchMailboxCounts(patches: Array<{ id: string; counts: Partial<MailboxCounts> }>): Promise<void>;
  deleteMailboxes(ids: string[]): Promise<void>;

  upsertEnvelopes(rows: EnvelopeRow[]): Promise<void>;
  /** keywords + mailboxIds only — the Email `updated` path (§5.3). */
  patchEnvelopeMutable(
    patches: Array<{ id: string; keywords: Record<string, boolean>; mailboxIds: Record<string, boolean> }>,
  ): Promise<void>;
  putBody(id: string, body: BodyRow): Promise<void>;
  /** Removes envelope + body + membership + body-queue rows for each id. */
  deleteEmails(ids: string[]): Promise<void>;

  enqueueBodies(entries: BodyQueueEntry[]): Promise<void>;
  updateBodyQueue(entries: BodyQueueEntry[]): Promise<void>;
  dequeueBodies(ids: string[]): Promise<void>;

  /** MUST be the last call in the txn (I1). */
  putCursor(cursor: SyncCursor): Promise<void>;
  putCoverage(coverage: CoverageState): Promise<void>;
  putAccountFlags(flags: Partial<Pick<AccountSyncState,
    'resyncRequired' | 'lastCycle' | 'consecutiveFailures' | 'lastFailedState'>>): Promise<void>;
}

export interface SyncStore {
  readonly accountId: LocalAccountId;
  readonly epoch: number;

  loadAccountState(): Promise<AccountSyncState>;

  /**
   * Runs `fn` as one unit. Rejects (and rolls back where the backend can) on any error.
   * Rejects with EpochMismatchError if the account's epoch changed since open (§8.3).
   */
  transaction<T>(fn: (txn: SyncTxn) => Promise<T>): Promise<T>;

  // ── reads (offline UI + retention + FTS) ──
  getEnvelope(id: string): Promise<EnvelopeRow | null>;
  getBody(id: string): Promise<BodyRow | null>;
  listMailboxes(): Promise<MailboxRow[]>;
  /** Indexed; replaces the O(cache) scan of D3. */
  queryEnvelopes(q: {
    mailboxId?: string;
    receivedBefore?: string;
    receivedAfter?: string;
    hasBody?: boolean;
    limit: number;
    offset?: number;
  }): Promise<EnvelopeRow[]>;
  countEnvelopes(q?: { mailboxId?: string }): Promise<number>;
  bodyBytesTotal(): Promise<number>;
  /** Oldest-body-first, for retention eviction. */
  listBodiesForEviction(limit: number): Promise<Array<{ id: string; receivedAt: string; bytes: number }>>;
  takeBodyQueue(limit: number, now: number): Promise<BodyQueueEntry[]>;

  /** Records only; cursors are invalidated via resyncRequired, never nulled (§7.5 rule 6). */
  clearRecords(): Promise<void>;
  /** Full namespace removal, per §8.4. */
  purge(): Promise<void>;
}

export interface SyncStoreFactory {
  open(accountId: LocalAccountId): Promise<SyncStore>;
  listAccounts(): Promise<LocalAccountId[]>;
  completePendingPurges(): Promise<void>;   // called once at launch (§8.4)
}
```

The engine imports `SyncStore` and nothing else about persistence. No AsyncStorage import, no
`expo-sqlite` import, no SQL, no key strings outside `store.ts`.

### 9.2 The AsyncStorage backend's honest limitation

AsyncStorage has no multi-key transaction. `transaction()` on that backend therefore provides
**ordering, not atomicity**:

1. Perform every record write, awaiting each. Any rejection aborts before the cursor is touched.
2. Write the cursor / coverage / flags **last**, as a single `AccountSyncState` blob.

A crash between 1 and 2 leaves records written and the cursor behind → replay → I5 makes it a
no-op. A crash *inside* 1 leaves a partially-applied page and an unchanged cursor → replay
completes it. Both are safe. The one thing that must never happen — cursor ahead of records — is
prevented by ordering alone.

Two hard requirements on this backend, both closing D2: `multiSet` is used where available and
its rejection propagates; and `putCursor` never runs unless every preceding write resolved. The
existing fire-and-forget `void AsyncStorage.setItem(...).catch(warn)` pattern is banned in the
sync path.

Under SQLite (step 6), `transaction()` becomes a genuine `BEGIN … COMMIT` and the ordering
requirement becomes redundant but harmless. **No engine code changes** — which is the test of
whether this boundary was drawn in the right place.

### 9.3 Schema sketch (informs both backends)

```sql
-- step 6 shape; the AsyncStorage backend emulates the same access patterns.
CREATE TABLE mailbox (
  id TEXT PRIMARY KEY, jmap_account_id TEXT NOT NULL, name TEXT NOT NULL,
  parent_id TEXT, role TEXT, sort_order INTEGER,
  total_emails INTEGER, unread_emails INTEGER, total_threads INTEGER, unread_threads INTEGER,
  my_rights TEXT, is_subscribed INTEGER
);
CREATE TABLE envelope (
  id TEXT PRIMARY KEY, jmap_account_id TEXT NOT NULL, thread_id TEXT,
  received_at TEXT NOT NULL, size INTEGER, subject TEXT, preview TEXT,
  from_json TEXT, to_json TEXT, cc_json TEXT,
  has_attachment INTEGER, keywords_json TEXT NOT NULL,
  has_body INTEGER NOT NULL DEFAULT 0, body_bytes INTEGER NOT NULL DEFAULT 0,
  cached_at INTEGER NOT NULL
);
CREATE INDEX envelope_received ON envelope(received_at DESC);
-- Membership is its own table: an email is in many mailboxes, and listing by folder
-- must be an index seek, not a scan of every cached body (D3).
CREATE TABLE email_mailbox (
  email_id TEXT NOT NULL, mailbox_id TEXT NOT NULL,
  PRIMARY KEY (email_id, mailbox_id)
);
CREATE INDEX email_mailbox_by_mailbox ON email_mailbox(mailbox_id);
CREATE TABLE body (email_id TEXT PRIMARY KEY, json TEXT NOT NULL, bytes INTEGER NOT NULL);
CREATE TABLE body_queue (
  email_id TEXT PRIMARY KEY, jmap_account_id TEXT NOT NULL, received_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error TEXT
);
CREATE TABLE sync_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);  -- cursors, coverage, flags
```

**Deliberately no foreign key** from `email_mailbox.mailbox_id` → `mailbox.id`, and none from
`email_mailbox.email_id` → `envelope.id` with a cascade that could delete envelopes. Per §5.5
the two change streams are not transactionally coupled, so membership rows referencing a
not-yet-fetched or already-destroyed mailbox are a normal transient state. A FK here would turn
correct behaviour into a constraint violation, and a cascade would delete mail on mailbox
deletion, violating I7.

`sync_state` living in the same database file as the records is what makes §8.4's atomic wipe
work.

### 9.4 Reserved hooks

- **FTS5 (step 9):** `upsertEnvelopes` / `putBody` are the only write paths for indexable
  content, so index population is a trigger or an in-transaction insert there. No engine change.
- **Attachment blobs:** today `expo-file-system` under `Paths.document/offline-attachments/`
  (`offline-cache-store.ts:2-4`). Out of scope; when added, blob deletion belongs in
  `deleteEmails` and `purge` so it cannot leak past an account wipe.

---

## 10. Triggering

### 10.1 Triggers

| # | Trigger | Job(s) | Throttle |
|---|---|---|---|
| T1 | Live session established (cold start, `auth-store` → `session != null`) | A, then B if `coverage.phase !== 'complete'`, then C | 2 s delay (keeps today's behaviour, `App.tsx:280-282`) |
| T2 | App foreground (`AppState` → `active`) | A, C | min 30 s since last cycle |
| T3 | Pull-to-refresh | A, C | none (user-initiated); coalesces into a running cycle |
| T4 | Network regained (`network-store` false→true) | A, C | 3 s debounce + per-account jitter |
| T5 | Push `StateChange` (SSE now, WebSocket later) | A, C | 2 s debounce, plus the state-equality check of §10.4 |
| T6 | Retention setting changed | B (widen) or eviction only (narrow) | none |
| T7 | `drainPending` true at launch | A | immediate, no 2 s delay |
| T8 | Background refresh (later, out of scope) | A, C with background budgets | OS-governed |

Explicitly **not** a trigger: a periodic foreground timer. Push (T5) plus foreground (T2) plus
network-recovery (T4) covers the ground; a polling interval would burn battery for cases already
covered. `push.ts:163-202`'s `startPolling` remains only as the transport fallback when neither
WebSocket nor SSE is available, and when it is active its state-change events arrive as T5.

### 10.2 Not triggered by

Opening a mailbox, opening a message, or scrolling. Those are `email-store` concerns and already
have their own network paths. The engine must never be on the critical path of a UI interaction —
if it is, its budgets and backoff become user-visible latency.

### 10.3 Single-flight and coalescing (closes D7)

Per `LocalAccountId`:

```
runCycle(accountId, reason):
  if inFlight(accountId):
     wakePending[accountId] |= reason        # remember WHY, don't abort
     return inFlight[accountId]              # callers await the same promise
  ...run...
  finally:
     if wakePending[accountId]: schedule another cycle immediately
```

The running cycle is never aborted to serve a new trigger — that is D7's bug, where "Sync now"
during a sync produced a cancelled sync and nothing else. It is aborted only by: account switch,
logout/purge, network loss, app background (at the next page boundary), or a budget deadline —
all of which leave a committed cursor and a resumable drain.

Cross-account: cycles for *different* accounts may run concurrently, but are serialised in
practice because `jmapClient` is a singleton bound to one account (§8.3 re-checks before every
call). v1 therefore syncs **only the active account**; a background multi-account sweep needs a
non-singleton client and is out of scope.

### 10.4 Push, and the WebSocket question

`StateChange` (RFC 8620 §7.1) is `{ changed: { <jmapAccountId>: { <type>: <newState> } } }` —
already typed (`types.ts:587-590`) and already routed to the stores
(`email-store.ts:969-1003`).

Engine handling:

```
onStateChange(change):
  for (jmapAccountId, types) of change.changed:
    if not one of ours: ignore
    if types.Email    and types.Email    !== cursor(Email, jmapAccountId)?.state:    wake = true
    if types.Mailbox  and types.Mailbox  !== cursor(Mailbox, jmapAccountId)?.state:  wake = true
    if types.EmailDelivery: wake = true          # no /changes for it; signal only
  if wake: debounce(2s) -> runCycle(reason: 'push')
```

Two rules, both load-bearing:

- **The pushed `newState` is never written as a cursor.** It is the server's *current* state; our
  cursor is our *last applied* state. Assigning it would skip every change in between —
  permanently, silently, and precisely for the mail the push was announcing. This is the single
  most tempting wrong optimisation in the whole design.
- **State equality is a cheap, safe dedupe.** If the pushed state equals our cursor, we are
  already current and can skip the round-trip entirely. Common when our own mutation caused the
  change.

**JMAP WebSocket (the sibling Electron decision).** The Electron client confirmed
`stalwart.sandbox.vnc.de` advertises `urn:ietf:params:jmap:websocket` with `supportsPush: true`
at `wss://stalwart.sandbox.vnc.de/jmap/ws` (manual §4/§5, independently confirmed twice).
**Decision for mobile: yes, eventually — foreground only, as a transport swap behind the same
handler.** Wiring is out of scope here; the design constraint it imposes now is that the engine's
push entry point is `onStateChange(change: StateChange)` and nothing else, so the transport
ladder becomes:

```
foreground: WebSocket (if session advertises it) -> SSE (push.ts:120) -> polling (push.ts:163)
background: FCM/APNs via vncmail-relay -> wakes the app -> T5/T8
```

A mobile app must not hold a WebSocket open in the background (doze, battery, OS socket
reclamation); the relay path already exists for that and is the right one. Because all three
foreground transports emit the same `StateChange`, swapping them changes zero lines in the
engine — which is the point of putting the boundary at `onStateChange` rather than inside it.

### 10.5 Headless-callability constraint (for step T8 later)

Even though background scheduling is out of scope, the engine must already satisfy: no dependency
on React, on a mounted component, or on a Zustand store for *correctness* (progress reporting is
an optional observer); a cycle callable as `runCycle(accountId, {budget: 'background'})`; and a
cooperative deadline checked between pages so it can commit and return before the OS budget
expires. Honouring this now is nearly free; retrofitting it means unpicking store coupling later.

---

## 11. Failure-mode enumeration

Every row is a concrete scenario with the concrete rule, and is intended to become a test case
(§13). "Cursor" = the `Email`/`Mailbox` cursor for the account in question.

| # | Scenario | Rule |
|---|---|---|
| F1 | App killed by OS mid-page-drain | Cursor is the last fully-applied page (I1). Next launch sees `drainPending`, re-requests the same `sinceState`, re-applies idempotently (I5). Cost: ≤1 page. |
| F2 | App killed mid-body-download | Body queue entry stays queued (job C is separate state). Envelope already durable. Next cycle re-fetches that body. Cursor untouched. |
| F3 | App killed mid-bootstrap coverage scan | `scanCursor` is the last committed page's `max(receivedAt)`; scan resumes there. Cursors were captured in step 1 (§4.1), so nothing is lost regardless of when the kill happened. |
| F4 | App killed mid-purge | `purgePending` tombstone in the registry; purge completes at next launch *before* any cycle runs (§8.4). |
| F5 | Two rapid foreground events → overlapping runs | Single-flight per account; second call sets `wakePending` and awaits the in-flight promise. No abort (closes D7). |
| F6 | Pull-to-refresh during a running cycle | Same as F5. User-initiated triggers never cancel work. |
| F7 | Mailbox deleted server-side mid-sync | `Mailbox/changes destroyed` → delete the mailbox row only. Email records untouched (I7); their truth arrives on `Email/changes` as `destroyed` or `updated` `mailboxIds`. No cascade. |
| F8 | Envelope references a mailbox we haven't fetched | Keep the membership row; no FK (§9.3). Folder appears when `Mailbox/changes` catches up. |
| F9 | `cannotCalculateChanges` | StateInvalid → invalidate cursor, `resyncRequired = true`, reconcile per §7.6. Records stay readable, marked stale, until the rebuild's sweep. |
| F10 | Server rebuild / `newState` unrecognised or regressed | Detected either as F9 or by `res.oldState !== cursor.state`. Same reconcile path. A cursor is never silently replaced by an unrelated token (I2/I3). |
| F11 | `Email/get` returns `notFound` for an id from `created`/`updated` | Destroyed between the two calls. Skip the id; page still counts as applied; no retry, no error. |
| F12 | `Email/get` batch fails mid-page (5xx) | Records already written stay (§7.4); cursor unchanged; page replays next cycle. |
| F13 | Network drops mid-cycle | Transport class → cursor unchanged, cycle `abandoned`/`failed`; T4 re-triggers on recovery. No error banner if the device reports offline (§7.3). |
| F14 | `hasMoreChanges` never becomes false (firehose or server bug) | Page budget (§6.4) ends the cycle `partial` with the cursor at the last committed page. Progress every cycle; no infinite loop (I9), no wedge. |
| F15 | HTTP 429 / `urn:…:error:limit` `rateLimit` | RateLimit class: honour `Retry-After` (already parsed, `jmap-client.ts:436-440`), full-jitter backoff, cursor unchanged. |
| F16 | Method error type we don't recognise | Default to ServerTransient — retry and back off. Never Fatal, never StateInvalid (§7.1). |
| F17 | `invalidArguments` (our bug) | Fatal: no retry, cursor unchanged, cycle `failed`, logged loudly. Escalates via §7.7 after 5 cycles, so even our own bug can't permanently wedge the account (I10). |
| F18 | Same `sinceState` fails 5 cycles running | §7.7 ladder: halve `maxChanges` → omit `maxChanges` → escalate to reconcile. Self-heals. |
| F19 | `sessionState` changed (accounts/capabilities differ) | Re-read the session; if the primary `jmapAccountId` changed, treat the old account's cursors as belonging to a different account and reconcile. `maxObjectsInGet` / `maxCallsInRequest` are re-read for batch sizing. |
| F20 | 401 mid-cycle after the client's own refresh retry | Auth class: cursor unchanged, cycle abandoned. **Never** purges or clears records — only the auth store's explicit logout does (§8.4). |
| F21 | Account switched mid-cycle | Epoch guard: next commit is rejected, cycle abandoned; nothing lands in the wrong namespace (I6, closes D6). |
| F22 | Logout mid-cycle | Epoch bump + purge tombstone; in-flight commits rejected; purge completes even if the cycle was mid-page. |
| F23 | Retention window widened (7 → 30 days) | Not a resync. `targetFrom` moves back; job B scans ascending from the new `targetFrom` to `coveredFrom`. Cursors untouched (§7.5 rule 6). |
| F24 | Retention window narrowed (30 → 7 days) | Evict records below the new floor; `coveredFrom = targetFrom`. Cursors untouched. |
| F25 | MB cap exceeded | Evict **bodies** oldest-first (envelopes survive, so the message stays listed and openable online). Cursors untouched. Body queue entries for evicted-window messages are dropped. |
| F26 | `updated` arrives for an id we don't hold (evicted or out of window) | Include it in the 3-property `updated` batch; retention decides whether to keep the resulting record. Never resurrect a body. Never fail the page. |
| F27 | `destroyed` arrives for an id we never held | No-op. Page still applied, cursor still advances. |
| F28 | Delta reverts an unflushed offline mutation | Re-apply pending outbox ops (full-state, idempotent) on top of the server state after each delta (§5.6). Server is the base; local intent is the overlay. |
| F29 | Pending outbox `destroy` for a message the delta reports `created`/`updated` | Apply server state, do not enqueue a body, let the flush + subsequent `destroyed` remove it. |
| F30 | Storage write fails (disk full, quota) | Cycle fails immediately, cursor unchanged, error surfaced (I4). Never warn-and-continue (closes D2). |
| F31 | Device clock wrong / skewed / DST | No correctness impact (I8). Cursors are opaque server strings; `scanCursor` is a server `receivedAt`. Only the window boundary and backoff delays use the device clock. |
| F32 | Corrupt local record (unparseable JSON) | Delete the record, enqueue a re-fetch, log. Do **not** invalidate the cursor — one bad row is not a state problem. |
| F33 | Coverage scan makes no forward progress (`receivedAt` tie cluster) | No-forward-progress guard: `anchor`/`anchorOffset`, then +1 ms, with a warning (§6.1). Cannot loop forever. |
| F34 | Two devices on the same account | Nothing special. Cursors are per-device; each converges independently. The other device's mutations arrive as ordinary `updated`. |
| F35 | User clears the cache from Settings while a cycle runs | `clearRecords()` wipes records and sets `resyncRequired`; the in-flight cycle's commit is rejected by the epoch guard; reconcile rebuilds. Cursors are not nulled (§7.5 rule 6) — a null cursor plus an empty store is indistinguishable from "never synced", which is fine, but `resyncRequired` makes the intent explicit and survives a crash. |
| F36 | Server returns `hasMoreChanges: true` with all-empty arrays | Treat as a valid page: advance the cursor to `newState`, continue draining. Counts against the page budget, so a server that does this forever still terminates. |

---

## 12. Required changes outside the engine

Not part of the engine, but the engine cannot be correct without them. Each is small.

### 12.1 `src/api/email.ts` — typed change results

`getEmailChanges` / `getMailboxChanges` must stop collapsing every error to `null` (D5):

```ts
export type JmapMethodErrorType =
  | 'cannotCalculateChanges' | 'serverUnavailable' | 'serverFail' | 'serverPartialFail'
  | 'requestTooLarge' | 'invalidArguments' | 'unknownMethod' | 'forbidden'
  | 'accountNotFound' | 'accountNotSupportedByMethod' | 'stateMismatch'
  | 'unknown';                       // -> ServerTransient by default (§7.1)

export interface JmapMethodError { type: JmapMethodErrorType; description?: string; raw?: unknown; }
export type JmapResult<T> = { ok: true; value: T } | { ok: false; error: JmapMethodError };

export function getEmailChangesResult(
  sinceState: string, opts?: { maxChanges?: number; accountId?: string },
): Promise<JmapResult<EmailChangesResult>>;

export function getMailboxChangesResult(
  sinceState: string, opts?: { accountId?: string },
): Promise<JmapResult<MailboxChangesResult>>;   // + updatedProperties: string[] | null
```

Also needed:
- `MailboxChangesResult` gains `updatedProperties: string[] | null` (§5.2).
- `getEmailProperties(ids, properties, accountId)` — a generic `Email/get` for the 3-property
  `updated` path and the envelope tier, without `getEmailsWithState`'s fixed property list and
  without its `state` return (which must not be used as a cursor, D4/I2).
- `getMailboxProperties(ids, properties, accountId)` for the `updatedProperties` patch path.
- `queryEmailWindow({after, before, limit, sort, anchor, anchorOffset, accountId})` for §6.1's
  keyset scan, returning `{ ids }` (no `queryState` — the engine doesn't use `queryChanges`).

The existing `getEmailChanges`/`getMailboxChanges` can stay as thin wrappers so `email-store` is
untouched by this step. Fixing D4 in `email-store.ts:885-889` is a separate, small change and
should be its own commit — it is a real bug in shipped code, independent of this engine.

### 12.2 `src/api/jmap-client.ts`

- Parse request-level errors: RFC 8620 §3.6.1 returns HTTP 400 with
  `application/problem+json` and a `type` URN (`urn:ietf:params:jmap:error:limit` carries
  `limit: "maxSizeRequest" | "maxCallsInRequest" | "maxConcurrentRequests" | "rateLimit"`).
  `request()` currently throws `new Error("JMAP request failed: " + status)` for any non-2xx
  (`:442-445`), discarding this. Add `RequestLimitError` / `ServerError` carrying the parsed
  type so §7.1 can classify.
- Accept an `AbortSignal` so a cycle can be cut at a page boundary on background/logout, and add
  a per-request timeout (`secureFetch`'s native path already takes `timeoutMs`; the plain
  `fetch` path has none, so a hung socket currently hangs a cycle until the OS gives up).
- Expose `sessionState` from responses (`JMAPResponseBody.sessionState` is already typed,
  `types.ts:33-36`) for F19.

### 12.3 Stores and UI

- **New** `src/stores/sync-status-store.ts` — phase/progress/error for the banner, an observer of
  the engine, never an input to it.
- `offline-cache-store.ts` — its `SyncState`/`SyncPhase` and the record cache are superseded.
  `OfflineCacheBanner` needs the new phases (`bootstrapping`, `delta`, `bodies`, `resyncing`,
  `partial`) mapped onto its existing five. `AboutDataSettings` gains "envelopes / bodies" split
  stats and a "re-sync now" action (sets `resyncRequired`).
- `email-store.ts` — cache-seed and offline-fallback reads move to `SyncStore.queryEnvelopes`
  (§5.7). No change to its `queryChanges` path.
- `src/lib/offline-sync.ts` — deleted; `formatBytes` (`:150-155`) moves to a util, it is imported
  by `OfflineCacheBanner:10` and `AboutDataSettings:12`.

---

## 13. Test plan

The `[QA]` gate for this step. `apply.ts` being pure (§2.2) is what makes most of this cheap.

**Unit, no network (vitest, the repo's existing runner):**
- Every row of §11 that is expressible as `apply(localState, page, fetched) → mutations`:
  F7, F8, F11, F26, F27, F28, F29, F36, plus §5.4's create/update/destroy overlap ordering.
- Cursor state machine: all seven rules of §7.5, especially rule 3 (empty page advances) and
  rule 5 (a `get` `state` is rejected as a cursor — the D4 regression test).
- `classify()` over the whole §7.1 taxonomy, including the unknown-type default (F16).
- Backoff: monotonic, jittered, capped, `Retry-After` override.
- Retention: F23–F25 window widen/narrow/cap.

**Integration against the `integration/` Stalwart fixture** (docker-compose, alice/bob/carol —
reuse it, per the skill's pre-flight; no new backend):
- Bootstrap → deliver mail *during* the coverage scan → assert the first delta cycle picks it up.
  This is the §4.1 ordering test and the highest-value test in the list.
- Multi-page drain with `maxChanges` forced to 2; kill the process between pages (SIGKILL, not a
  graceful abort); relaunch; assert convergence and no duplicate or missing records (F1).
- Flag toggle from a second client → assert the local envelope's `keywords` updates and **no body
  refetch occurs** (network assertion, not just a state assertion — this is D1/§5.3).
- Mailbox delete with `onDestroyRemoveEmails` both true and false (F7).
- Force `cannotCalculateChanges` (stale `sinceState`) → assert reconcile runs, records stay
  readable throughout, and the sweep deletes exactly the server-absent ids (F9/§7.6).
- Airplane-mode read path + two-account isolation, per the skill's step 8 smoke test.
- Purge: kill mid-purge, relaunch, assert no records remain and no cursor survives (F4/F22).

**Property/fuzz (cheap, high yield here):** generate random change pages (with legal overlaps
per §5.4) and random kill points; assert the local store converges to the same state as a
from-scratch bootstrap. This is the test that finds ordering bugs no hand-written case will.

---

## 14. Rollout and migration

1. **Discard, don't migrate.** On first run of the new engine, delete the
   `webmail:offline-cache:{index,entry}:v2:*` namespace and bootstrap fresh. The old cache is
   unencrypted JSON with stale keywords (D1) and no cursor; a single sync rebuilds it. Migrating
   would mean trusting records whose provenance we can't establish.
2. **Feature flag** `offlineSyncEngineV2` in `settings-store`, default off, so the old path stays
   available during dogfood. Both must not run concurrently — the flag gates trigger
   registration in `App.tsx`, not just the engine body.
3. **Order of work:** `SyncStore` + AsyncStorage backend and `apply.ts` first (fully unit-tested
   with no engine), then cursors/drain, then coverage, then bodies, then triggers, then UI. The
   Android emulator smoke gate (`.github/workflows/android-emulator-smoke.yml`) must stay green
   at every step.
4. **Then step 6** swaps the backend. If that swap requires touching anything under `src/sync/`
   other than `store*.ts`, the boundary of §9 was drawn wrong and should be fixed rather than
   worked around.

**Adjacent, flagged for the human, not acted on here:** `app.config.js` currently declares
`ios.config.usesNonExemptEncryption: false`, which must flip when SQLCipher ships in the iOS
binary (skill step 13). And `git ls-files` shows `android/` **is** tracked in this repo while
`.gitignore` ignores only `/ios` — which sits uneasily with the manual §4 "stay CNG, don't commit
`ios`/`android`" decision, and will matter at step 6 when the `expo-sqlite` plugin has to
regenerate the Android project. Both are step-6 concerns, neither affects this design.

---

## 15. Summary of key decisions

1. **Three independent state machines** — delta cursor, historical coverage, body queue — each
   with its own persisted state. This is what lets the cursor advance while bodies lag, makes a
   retention change not look like a resync, and caps crash cost at one unit of work per machine.
2. **Bootstrap: replace the code, keep the shape.** Still a query-driven bulk scan, because
   `/changes` structurally cannot deliver pre-existing mail — but rewritten, because
   `runOfflineSync` captures no cursor (a permanent, silent gap), cannot page stably, cannot
   resume, and fetches at the wrong granularity.
3. **Capture cursors *before* enumerating** (§4.1). Errs toward re-delivering changes, never
   toward gaps. The reverse order is cheaper and silently loses mail.
4. **An `updated` Email costs a 3-property fetch, never a body.** RFC 8621 §4.1: `keywords` and
   `mailboxIds` are the only mutable properties. Largest efficiency win over today, and it fixes
   the shipped bug where offline read/unread state is permanently wrong (D1).
5. **Cursor-last, always** (I1). A crash re-delivers a page; it never skips one. Under
   AsyncStorage this is enforced by write ordering; under SQLite it becomes a real transaction,
   with no engine change.
6. **Only a `Foo/changes.newState` may become a cursor** (I2). Not an `Email/get` `state`, not a
   `queryState`, not a pushed `StateChange` value. Each of those would silently skip changes, and
   the first is a live bug in `email-store.ts:885-889` today (D4).
7. **Failure means the cursor stands still.** Exactly one error class moves it, and that class's
   action is a verified full rebuild. Everything else retries from the same point.
8. **`cannotCalculateChanges` is handled as the spec mandates, without blanking the UI** (§7.6):
   the cache is invalidated and every record is re-verified or deleted, but deletion happens at
   the *end* of reconciliation, so an offline user isn't left with an empty inbox. Documented as a
   deliberate deviation from a literal "delete first" reading.
9. **No error path can wedge an account** (I10/§7.7). Five failed cycles on the same state
   escalates through halved `maxChanges` → no `maxChanges` → full reconcile, which is always
   achievable from cold.
10. **Records are never deleted by inference** (I7). Only `destroyed`, retention, the reconcile
    sweep, or purge. Consequently: no FK from email→mailbox, and no cascade.
11. **Everything is keyed by `(LocalAccountId, JmapAccountId, CursorType)`,** and no sync state
    lives in a global key — so step 6's per-account SQLCipher wipe removes cursors and records
    together. A cursor surviving a data wipe is the worst reachable state, and §8.1 + §8.4 make it
    unreachable.
12. **Single-flight with coalescing, never abort-to-serve** (§10.3), fixing today's "Sync now
    during a sync cancels the sync" behaviour (D7).
13. **Push is a wake signal, not a cursor** (§10.4). Mobile will consume the same JMAP WebSocket
    the Electron client uses — foreground only, as a transport swap behind
    `onStateChange(StateChange)`; background stays on the relay. Zero engine lines change when
    the transport does.
14. **The engine talks only to `SyncStore`** (§9). If step 6 requires editing anything under
    `src/sync/` besides `store*.ts`, the boundary was drawn wrong.

### Open questions for the human

Deliberately few — this pass was meant to be decisive. Everything else above is a made decision,
and the reviewer should attack the decisions rather than expect optional slots.

1. **Envelope-window default.** §2.1 sets envelope window = body window = `offlineCacheDays`
   (default 7) so v1 changes no user-visible behaviour. Envelopes are ~1 KB, so "envelopes: 1
   year, bodies: 30 days" is affordable and would make offline search (step 9) far more useful.
   Product call, not a technical one; the schema supports either today.
2. **Whether `offlineCacheEnabled` should still default to `false`.** With tiered storage and
   incremental sync, the cost of leaving it on is a few hundred KB and a handful of requests per
   day — very different from today's bulk re-download. Turning it on by default is what makes the
   feature actually reach users, but it is a data-usage default and therefore the human's call.

Neither blocks implementation: (1) is one constant, (2) is one boolean.
