// The storage boundary (design §9.1). The engine imports this and nothing else
// about persistence: no SQL, no expo-sqlite, no AsyncStorage, no key strings
// outside `store-*.ts`.

import type { EmailAddress } from '../api/types';
import type {
  ChangesState,
  CursorType,
  EnumerationCommitment,
  JmapAccountId,
  LocalAccountId,
} from './states';

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Row identity is `(jmapAccountId, id)` everywhere — S3. JMAP ids are unique
 * only WITHIN an account, and the codebase already works around that at
 * `email.ts:19-20` (`sharedMailboxId`), so a bare-id key would silently merge
 * two accounts' rows the moment shared/group accounts land.
 */
export interface RowKey {
  jmapAccountId: JmapAccountId;
  id: string;
}

export interface CursorKey {
  jmapAccountId: JmapAccountId;
  type: CursorType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Record tiers (§2.1)
// ─────────────────────────────────────────────────────────────────────────────

export interface MailboxCounts {
  totalEmails: number | null;
  unreadEmails: number | null;
  totalThreads: number | null;
  unreadThreads: number | null;
}

export interface MailboxRow extends MailboxCounts {
  jmapAccountId: JmapAccountId;
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
  sortOrder: number | null;
  myRights: Record<string, boolean> | null;
  isSubscribed: boolean;
}

/**
 * The envelope tier — `EMAIL_LIST_PROPERTIES` (`email.ts:6-9`).
 *
 * `mailboxIds` is a logical field, not a column: §9.3 keeps membership in its
 * own `email_mailbox` table so listing by folder is an index seek rather than a
 * scan of every cached body (D3). Backends split it on write and re-join it on
 * read; the engine never sees the difference.
 */
export interface EnvelopeRow {
  jmapAccountId: JmapAccountId;
  id: string;
  threadId: string | null;
  /** Server-provided; the coverage scan's resume point derives from it (I8). */
  receivedAt: string;
  size: number | null;
  subject: string | null;
  preview: string | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  hasAttachment: boolean;
  /** Mutable per RFC 8621 §4.1. */
  keywords: Record<string, boolean>;
  /** Mutable per RFC 8621 §4.1. */
  mailboxIds: Record<string, boolean>;
  hasBody: boolean;
  bodyBytes: number;
  cachedAt: number;
}

/**
 * The body tier. `json` is opaque to the store — the serialised
 * `bodyStructure/textBody/htmlBody/bodyValues/attachments/blobId/bcc/replyTo/sentAt`
 * set. `receivedAt` is duplicated here on purpose (S12) so eviction is a
 * single-table ordered scan that cannot be blinded by a missing join.
 */
export interface BodyRow {
  jmapAccountId: JmapAccountId;
  emailId: string;
  receivedAt: string;
  json: string;
  bytes: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persisted sync state (§3.1)
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncCursor {
  type: CursorType;
  jmapAccountId: JmapAccountId;
  /** A ChangesState from this (type, jmapAccountId), or a seeded SnapshotState (§3.2). */
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

export interface CoverageState {
  jmapAccountId: JmapAccountId;
  /** ISO. Oldest receivedAt for which the ENVELOPE tier is known-complete. */
  coveredFrom: string | null;
  /** ISO. Ascending scan resume point; null when not scanning. */
  scanCursor: string | null;
  /** The retention floor this scan is working toward. */
  targetFrom: string;
  /** S2 — the floor PINNED at reconcile start. The sweep deletes only against this. */
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

export interface BodyQueueEntry {
  emailId: string;
  jmapAccountId: JmapAccountId;
  /** Drives priority: newest first. */
  receivedAt: string;
  /** NEVER reset by a re-enqueue (S12/F41). */
  attempts: number;
  lastError?: string;
  nextAttemptAt?: number;
}

export interface LastCycle {
  startedAt: number;
  finishedAt?: number;
  outcome: 'ok' | 'partial' | 'failed' | 'abandoned';
  /** True when ANY job committed something — drives the chaining rule of §10.3. */
  madeProgress: boolean;
  error?: string;
}

/**
 * A VIEW, not a write unit (S1/I12). There is deliberately no method anywhere
 * that writes this struct whole: every mutation is a field-level patch on
 * `SyncTxn`, applied read-merge-write inside the transaction.
 *
 * `epoch` is deliberately NOT a field — it is owned by the registry, outside the
 * per-account namespace, because it must be monotonic ACROSS a purge (§8.3).
 */
export interface AccountSyncState {
  schemaVersion: number;
  /** Keyed by (type, jmapAccountId). */
  cursors: SyncCursor[];
  /** Keyed by jmapAccountId. */
  coverage: CoverageState[];
  /** Sticky until a reconcile completes (§7.6). Survives restarts. */
  resyncRequired: boolean;
  /** Rolling count + window start for the reconcile ceiling of §7.6.1. */
  reconcilesInWindow: number;
  reconcileWindowStartedAt: number;
  /** Last observed retention floor, for the clock-jump guard of F44. */
  lastWindowFloor?: string;
  lastCycle?: LastCycle;
}

/** The account-level scalars `patchAccountFlags` may write. */
export type AccountFlagsPatch = Partial<
  Pick<
    AccountSyncState,
    | 'resyncRequired'
    | 'lastCycle'
    | 'reconcilesInWindow'
    | 'reconcileWindowStartedAt'
    | 'lastWindowFloor'
  >
>;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `AccountSyncState` failed to parse. The caller applies I13 — set
 * `resyncRequired` and treat every cursor as invalidated — rather than falling
 * back to "no cursors", which would leave a store full of unverified
 * pre-existing records that no sweep ever visits.
 */
export class CorruptStateError extends Error {
  constructor(
    message: string,
    readonly key: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CorruptStateError';
  }
}

/**
 * The registry's epoch for this account changed since the store was opened — an
 * account switch, logout, purge, `clearRecords()`, or the feature being disabled
 * landed concurrently (§8.3). The transaction is rolled back and nothing lands.
 */
export class EpochMismatchError extends Error {
  constructor(
    readonly accountId: LocalAccountId,
    readonly openedAt: number,
    readonly current: number,
  ) {
    super(
      `sync store epoch for ${accountId} moved ${openedAt} -> ${current}; ` +
        'rejecting the commit rather than writing over a concurrent mutation',
    );
    this.name = 'EpochMismatchError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The transaction surface
// ─────────────────────────────────────────────────────────────────────────────

/** One atomic unit of work. Under SQLite a real BEGIN…COMMIT. */
export interface SyncTxn {
  // ── records ──
  upsertMailboxes(rows: MailboxRow[]): Promise<void>;
  patchMailboxCounts(p: Array<{ key: RowKey; counts: Partial<MailboxCounts> }>): Promise<void>;
  deleteMailboxes(keys: RowKey[]): Promise<void>;

  upsertEnvelopes(rows: EnvelopeRow[]): Promise<void>;
  /** keywords + mailboxIds only — the Email `updated` path (§5.3). No-ops for absent ids. */
  patchEnvelopeMutable(
    p: Array<{
      key: RowKey;
      keywords: Record<string, boolean>;
      mailboxIds: Record<string, boolean>;
    }>,
  ): Promise<void>;
  /**
   * Writes the body only if its envelope still exists, and reports which
   * happened. Prevents orphan bodies when a body was fetched just before its
   * envelope was destroyed (F48, §5.1) — which is also why running bodies
   * concurrently with the delta path is forbidden (I11).
   */
  putBodyIfEnvelopeExists(key: RowKey, body: BodyRow): Promise<boolean>;
  /** Removes envelope + body + membership + body_queue rows for each key. */
  deleteEmails(keys: RowKey[]): Promise<void>;
  deleteBodies(keys: RowKey[]): Promise<void>;

  // ── body queue (S12) ──
  /** Insert-or-ignore. NEVER resets `attempts` on an existing row (F41). */
  enqueueBodies(entries: BodyQueueEntry[]): Promise<void>;
  /** Attempts/error/nextAttemptAt only. */
  updateBodyQueue(entries: BodyQueueEntry[]): Promise<void>;
  dequeueBodies(keys: RowKey[]): Promise<void>;

  // ── state: FIELD-LEVEL PATCHES ONLY (S1, I12). No whole-struct write exists. ──
  /**
   * The delta path's only cursor write. Cannot accept a `SnapshotState` — the
   * compiler rejects D4's shape at the call site. Throws if the cursor does not
   * exist: a cursor is born from `seedCursor` and nowhere else (I2/I3).
   */
  advanceCursor(key: CursorKey, next: ChangesState): Promise<void>;
  /**
   * Bootstrap/reconcile only. Writes the snapshot state AND the `CoverageState`
   * it justifies in the same transaction, so a seed is never durable without the
   * durable commitment to enumerate that justifies it (§3.2).
   */
  seedCursor(key: CursorKey, commitment: EnumerationCommitment): Promise<void>;
  patchCursor(
    key: CursorKey,
    patch: Partial<Omit<SyncCursor, 'type' | 'jmapAccountId' | 'state'>>,
  ): Promise<void>;
  patchCoverage(jmapAccountId: JmapAccountId, patch: Partial<CoverageState>): Promise<void>;
  patchAccountFlags(patch: AccountFlagsPatch): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvelopeQuery {
  jmapAccountId: JmapAccountId;
  mailboxId?: string;
  receivedBefore?: string;
  receivedAfter?: string;
  /** `false` is job C2's driver (S9): covered envelopes with no body yet. */
  hasBody?: boolean;
  limit: number;
  offset?: number;
}

export interface SyncStore {
  readonly accountId: LocalAccountId;
  readonly epoch: number;

  /**
   * Throws {@link CorruptStateError}; the caller applies I13 (`resyncRequired`)
   * rather than falling back to empty cursors.
   */
  loadAccountState(): Promise<AccountSyncState>;

  /**
   * Runs `fn` as one unit, serialised by a PER-ACCOUNT MUTEX (S1) so a cycle
   * commit and a concurrent `clearRecords()` / settings change cannot
   * interleave. State patches are applied read-merge-write inside the same
   * critical section. Rejects with {@link EpochMismatchError} if the registry's
   * epoch for this account changed since open — checked both before the work and
   * again before the commit lands (§8.3).
   */
  transaction<T>(fn: (txn: SyncTxn) => Promise<T>): Promise<T>;

  // ── reads (offline UI, retention, FTS, body backfill) ──
  getEnvelope(key: RowKey): Promise<EnvelopeRow | null>;
  /** Bulk presence test — filters `updated` ids before fetching (§5.3, F26). */
  whichEnvelopesExist(keys: RowKey[]): Promise<RowKey[]>;
  getBody(key: RowKey): Promise<BodyRow | null>;
  listMailboxes(jmapAccountId: JmapAccountId): Promise<MailboxRow[]>;
  /** Indexed. */
  queryEnvelopes(q: EnvelopeQuery): Promise<EnvelopeRow[]>;
  countEnvelopes(q?: { jmapAccountId?: JmapAccountId; mailboxId?: string }): Promise<number>;
  bodyBytesTotal(): Promise<number>;
  /** Oldest-body-first, from the body table alone (S12: it carries received_at). */
  listBodiesForEviction(
    limit: number,
  ): Promise<Array<{ key: RowKey; receivedAt: string; bytes: number }>>;
  /** Bodies with no surviving envelope — the orphan sweep (F45). */
  listOrphanBodies(limit: number): Promise<RowKey[]>;
  takeBodyQueue(limit: number, now: number): Promise<BodyQueueEntry[]>;

  /**
   * Records + body queue (S12), NOT cursors. Sets `resyncRequired` and bumps the
   * epoch via the factory (§8.3), so an in-flight cycle cannot write over it
   * (S1/F35/F37).
   */
  clearRecords(): Promise<void>;
  /** Full namespace removal, per §8.4. */
  purge(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory + the out-of-band store-format marker (§8.4.1)
// ─────────────────────────────────────────────────────────────────────────────

export interface StoreFormatMarker {
  storeFormat: 'sqlite-plain' | 'sqlite-cipher';
  schemaVersion: number;
}

export type PurgeReason = 'logout' | 'removed' | 'feature-disabled' | 'store-format-change';

export interface SyncStoreFactory {
  /** Lazy: never materialises a file or a key for an account whose feature is off (§9.5). */
  open(accountId: LocalAccountId): Promise<SyncStore>;
  isMaterialised(accountId: LocalAccountId): Promise<boolean>;
  listAccounts(): Promise<LocalAccountId[]>;
  epochFor(accountId: LocalAccountId): Promise<number>;
  bumpEpoch(accountId: LocalAccountId, reason: string): Promise<number>;

  /** Null when absent or unreadable — treated as a mismatch, i.e. purge. */
  readFormatMarker(accountId: LocalAccountId): Promise<StoreFormatMarker | null>;
  /** Written LAST when materialising a store, so a crash leaves a mismatch, not a false match. */
  writeFormatMarker(accountId: LocalAccountId, marker: StoreFormatMarker): Promise<void>;

  purgeAccount(accountId: LocalAccountId, reason: PurgeReason): Promise<void>;

  /**
   * Once at launch, before any cycle (§8.4). Completes pending purges AND purges
   * any account whose format marker doesn't match this build's expectation, with
   * reason `store-format-change` (§8.4.1).
   */
  completePendingPurges(): Promise<void>;
}
