// The shipping `SyncStore` backend (§9.2): plain expo-sqlite, no SQLCipher.
//
// Reordering SQLite ahead of the engine is what makes S1's atomicity a database
// property rather than a discipline — `transaction()` here is a real
// `BEGIN IMMEDIATE … COMMIT`, so cursor-last (I1) is enforced by SQLite instead of
// by write ordering plus hope — and it is what actually fixes D3, because
// `queryEnvelopes` is an index seek over `email_mailbox` rather than a scan of
// every cached body.

import type { MailboxRights } from '../api/types';
import { Mutex } from './mutex';
import type { SyncRegistry } from './registry';
import { syncRegistry } from './registry';
import {
  FLAGS_KEY,
  RECORD_TABLES,
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
  STORE_FORMAT,
  coverageStateKey,
  cursorStateKey,
  databaseNameFor,
} from './schema';
import { type SqliteDriver, expoSqliteHost, type SqliteHost } from './sqlite-driver';
import {
  type AccountFlagsPatch,
  type AccountSyncState,
  type BodyQueueEntry,
  type BodyRow,
  CorruptStateError,
  type CoverageState,
  type CursorKey,
  type EnvelopeQuery,
  type EnvelopeRow,
  EpochMismatchError,
  type LastCycle,
  type MailboxCounts,
  type MailboxRow,
  type PurgeReason,
  type RowKey,
  type StoreFormatMarker,
  type SyncCursor,
  type SyncStore,
  type SyncStoreFactory,
  type SyncTxn,
} from './store';
import {
  type ChangesState,
  coveragePhaseForCommitment,
  type EnumerationCommitment,
  type JmapAccountId,
  type LocalAccountId,
} from './states';

/** SQLite's default host-parameter ceiling is 999; stay well inside it. */
const PARAM_CHUNK = 400;

function chunk<T>(items: T[], size = PARAM_CHUNK): T[][] {
  if (items.length <= size) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function bool(v: unknown): boolean {
  return v === 1 || v === true;
}

/**
 * For a row that MUST parse: there is no sensible fallback for a cursor or a
 * coverage row, and substituting one would be exactly the "fall back to empty
 * cursors" behaviour I13 forbids — it would leave a store full of unverified
 * pre-existing records that no sweep ever visits (F43).
 */
function jsonRequired<T>(raw: unknown, key: string): T {
  if (raw === null || raw === undefined) {
    throw new CorruptStateError(`missing value for ${key}`, key);
  }
  try {
    return JSON.parse(String(raw)) as T;
  } catch (cause) {
    throw new CorruptStateError(`unparseable JSON in ${key}`, key, cause);
  }
}

function json<T>(raw: unknown, fallback: T, key: string): T {
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(String(raw)) as T;
  } catch (cause) {
    throw new CorruptStateError(`unparseable JSON in ${key}`, key, cause);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapping
// ─────────────────────────────────────────────────────────────────────────────

interface MailboxSqlRow {
  jmap_account_id: string;
  id: string;
  name: string;
  parent_id: string | null;
  role: string | null;
  sort_order: number | null;
  total_emails: number | null;
  unread_emails: number | null;
  total_threads: number | null;
  unread_threads: number | null;
  my_rights: string | null;
  is_subscribed: number | null;
}

function toMailboxRow(r: MailboxSqlRow): MailboxRow {
  return {
    jmapAccountId: r.jmap_account_id,
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    role: r.role,
    sortOrder: r.sort_order,
    totalEmails: r.total_emails,
    unreadEmails: r.unread_emails,
    totalThreads: r.total_threads,
    unreadThreads: r.unread_threads,
    myRights: json<MailboxRights | null>(r.my_rights, null, 'mailbox.my_rights'),
    isSubscribed: bool(r.is_subscribed),
  };
}

interface EnvelopeSqlRow {
  jmap_account_id: string;
  id: string;
  thread_id: string | null;
  received_at: string;
  size: number | null;
  subject: string | null;
  preview: string | null;
  from_json: string | null;
  to_json: string | null;
  cc_json: string | null;
  has_attachment: number | null;
  keywords_json: string;
  has_body: number;
  body_bytes: number;
  cached_at: number;
}

function toEnvelopeRow(r: EnvelopeSqlRow, mailboxIds: Record<string, boolean>): EnvelopeRow {
  return {
    jmapAccountId: r.jmap_account_id,
    id: r.id,
    threadId: r.thread_id,
    receivedAt: r.received_at,
    size: r.size,
    subject: r.subject,
    preview: r.preview,
    from: json(r.from_json, null, 'envelope.from_json'),
    to: json(r.to_json, null, 'envelope.to_json'),
    cc: json(r.cc_json, null, 'envelope.cc_json'),
    hasAttachment: bool(r.has_attachment),
    keywords: json<Record<string, boolean>>(r.keywords_json, {}, 'envelope.keywords_json'),
    mailboxIds,
    hasBody: bool(r.has_body),
    bodyBytes: r.body_bytes,
    cachedAt: r.cached_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction
// ─────────────────────────────────────────────────────────────────────────────

class SqliteTxn implements SyncTxn {
  constructor(private readonly db: SqliteDriver) {}

  // ── mailboxes ──

  async upsertMailboxes(rows: MailboxRow[]): Promise<void> {
    for (const r of rows) {
      await this.db.runAsync(
        `INSERT INTO mailbox (jmap_account_id, id, name, parent_id, role, sort_order,
           total_emails, unread_emails, total_threads, unread_threads, my_rights, is_subscribed)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(jmap_account_id, id) DO UPDATE SET
           name = excluded.name, parent_id = excluded.parent_id, role = excluded.role,
           sort_order = excluded.sort_order, total_emails = excluded.total_emails,
           unread_emails = excluded.unread_emails, total_threads = excluded.total_threads,
           unread_threads = excluded.unread_threads, my_rights = excluded.my_rights,
           is_subscribed = excluded.is_subscribed`,
        [
          r.jmapAccountId,
          r.id,
          r.name,
          r.parentId,
          r.role,
          r.sortOrder,
          r.totalEmails,
          r.unreadEmails,
          r.totalThreads,
          r.unreadThreads,
          r.myRights === null ? null : JSON.stringify(r.myRights),
          r.isSubscribed ? 1 : 0,
        ],
      );
    }
  }

  /**
   * The RFC 8621 §2.2 `updatedProperties` optimisation (§5.2): when only counts
   * changed, patch exactly those columns instead of re-fetching every folder
   * object. "May have changed" makes the list an upper bound, so patching
   * precisely those columns is correct.
   */
  async patchMailboxCounts(
    p: Array<{ key: RowKey; counts: Partial<MailboxCounts> }>,
  ): Promise<void> {
    const columns: Record<keyof MailboxCounts, string> = {
      totalEmails: 'total_emails',
      unreadEmails: 'unread_emails',
      totalThreads: 'total_threads',
      unreadThreads: 'unread_threads',
    };
    for (const { key, counts } of p) {
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      for (const [field, column] of Object.entries(columns) as Array<
        [keyof MailboxCounts, string]
      >) {
        const v = counts[field];
        if (v !== undefined) {
          sets.push(`${column} = ?`);
          params.push(v);
        }
      }
      if (!sets.length) continue;
      params.push(key.jmapAccountId, key.id);
      await this.db.runAsync(
        `UPDATE mailbox SET ${sets.join(', ')} WHERE jmap_account_id = ? AND id = ?`,
        params,
      );
    }
  }

  /**
   * Deletes the mailbox row ONLY. Email records are never touched (I7): if the
   * server destroyed the messages too, `Email/changes` reports them `destroyed`;
   * if it moved them, their `mailboxIds` update arrives as `updated`. Truth
   * arrives on the Email stream either way, and being wrong in this direction
   * costs a stale row rather than mail the user cannot read offline.
   */
  async deleteMailboxes(keys: RowKey[]): Promise<void> {
    for (const k of keys) {
      await this.db.runAsync('DELETE FROM mailbox WHERE jmap_account_id = ? AND id = ?', [
        k.jmapAccountId,
        k.id,
      ]);
    }
  }

  // ── envelopes ──

  /**
   * Note what this deliberately does NOT write on conflict: `has_body` and
   * `body_bytes`. Those belong to the body tier and are owned by
   * `putBodyIfEnvelopeExists` / `deleteBodies`. Clobbering them here would make
   * an idempotent page replay (I5) look like "body missing" to job C2 and
   * re-download every body in the page.
   */
  async upsertEnvelopes(rows: EnvelopeRow[]): Promise<void> {
    for (const r of rows) {
      await this.db.runAsync(
        `INSERT INTO envelope (jmap_account_id, id, thread_id, received_at, size, subject,
           preview, from_json, to_json, cc_json, has_attachment, keywords_json,
           has_body, body_bytes, cached_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(jmap_account_id, id) DO UPDATE SET
           thread_id = excluded.thread_id, received_at = excluded.received_at,
           size = excluded.size, subject = excluded.subject, preview = excluded.preview,
           from_json = excluded.from_json, to_json = excluded.to_json,
           cc_json = excluded.cc_json, has_attachment = excluded.has_attachment,
           keywords_json = excluded.keywords_json, cached_at = excluded.cached_at`,
        [
          r.jmapAccountId,
          r.id,
          r.threadId,
          r.receivedAt,
          r.size,
          r.subject,
          r.preview,
          r.from === null ? null : JSON.stringify(r.from),
          r.to === null ? null : JSON.stringify(r.to),
          r.cc === null ? null : JSON.stringify(r.cc),
          r.hasAttachment ? 1 : 0,
          JSON.stringify(r.keywords),
          r.hasBody ? 1 : 0,
          r.bodyBytes,
          r.cachedAt,
        ],
      );
      await this.replaceMembership(r.jmapAccountId, r.id, r.mailboxIds);
    }
  }

  private async replaceMembership(
    jmapAccountId: string,
    emailId: string,
    mailboxIds: Record<string, boolean>,
  ): Promise<void> {
    await this.db.runAsync(
      'DELETE FROM email_mailbox WHERE jmap_account_id = ? AND email_id = ?',
      [jmapAccountId, emailId],
    );
    for (const [mailboxId, present] of Object.entries(mailboxIds)) {
      if (!present) continue;
      await this.db.runAsync(
        'INSERT OR IGNORE INTO email_mailbox (jmap_account_id, email_id, mailbox_id) VALUES (?,?,?)',
        [jmapAccountId, emailId, mailboxId],
      );
    }
  }

  /**
   * `keywords` + `mailboxIds` are the only mutable Email properties (RFC 8621
   * §4.1), so an `updated` Email costs a 3-property fetch and never a body —
   * which is what closes D1.
   *
   * Absent ids are an unconditional no-op (F26/S16): absence means retention
   * decided against the message, or coverage has not reached it — and coverage
   * enumerates current state, so nothing needs the update replayed. Callers
   * should filter with `whichEnvelopesExist` first; this is the backstop.
   */
  async patchEnvelopeMutable(
    p: Array<{
      key: RowKey;
      keywords: Record<string, boolean>;
      mailboxIds: Record<string, boolean>;
    }>,
  ): Promise<void> {
    for (const { key, keywords, mailboxIds } of p) {
      const res = await this.db.runAsync(
        'UPDATE envelope SET keywords_json = ? WHERE jmap_account_id = ? AND id = ?',
        [JSON.stringify(keywords), key.jmapAccountId, key.id],
      );
      // Only touch membership when the envelope is actually here, or we would
      // leave membership rows for a record we do not hold.
      if (res.changes > 0) {
        await this.replaceMembership(key.jmapAccountId, key.id, mailboxIds);
      }
    }
  }

  async putBodyIfEnvelopeExists(key: RowKey, body: BodyRow): Promise<boolean> {
    if (body.jmapAccountId !== key.jmapAccountId || body.emailId !== key.id) {
      throw new Error('putBodyIfEnvelopeExists: body identity does not match key');
    }
    const exists = await this.db.getFirstAsync<{ one: number }>(
      'SELECT 1 AS one FROM envelope WHERE jmap_account_id = ? AND id = ?',
      [key.jmapAccountId, key.id],
    );
    if (!exists) return false;

    await this.db.runAsync(
      `INSERT INTO body (jmap_account_id, email_id, received_at, json, bytes)
       VALUES (?,?,?,?,?)
       ON CONFLICT(jmap_account_id, email_id) DO UPDATE SET
         received_at = excluded.received_at, json = excluded.json, bytes = excluded.bytes`,
      [key.jmapAccountId, key.id, body.receivedAt, body.json, body.bytes],
    );
    await this.db.runAsync(
      'UPDATE envelope SET has_body = 1, body_bytes = ? WHERE jmap_account_id = ? AND id = ?',
      [body.bytes, key.jmapAccountId, key.id],
    );
    await this.dequeueBodies([key]);
    return true;
  }

  async deleteEmails(keys: RowKey[]): Promise<void> {
    for (const k of keys) {
      const params = [k.jmapAccountId, k.id];
      await this.db.runAsync('DELETE FROM envelope WHERE jmap_account_id = ? AND id = ?', params);
      await this.db.runAsync('DELETE FROM body WHERE jmap_account_id = ? AND email_id = ?', params);
      await this.db.runAsync(
        'DELETE FROM email_mailbox WHERE jmap_account_id = ? AND email_id = ?',
        params,
      );
      await this.db.runAsync(
        'DELETE FROM body_queue WHERE jmap_account_id = ? AND email_id = ?',
        params,
      );
    }
  }

  async deleteBodies(keys: RowKey[]): Promise<void> {
    for (const k of keys) {
      await this.db.runAsync('DELETE FROM body WHERE jmap_account_id = ? AND email_id = ?', [
        k.jmapAccountId,
        k.id,
      ]);
      await this.db.runAsync(
        'UPDATE envelope SET has_body = 0, body_bytes = 0 WHERE jmap_account_id = ? AND id = ?',
        [k.jmapAccountId, k.id],
      );
    }
  }

  // ── body queue ──

  /**
   * Insert-or-ignore, and it NEVER resets `attempts` (S12/F41). Otherwise job C2
   * re-enqueuing a permanently failing body would defeat the give-up-after-5
   * rule and retry it forever.
   */
  async enqueueBodies(entries: BodyQueueEntry[]): Promise<void> {
    for (const e of entries) {
      await this.db.runAsync(
        `INSERT OR IGNORE INTO body_queue
           (jmap_account_id, email_id, received_at, attempts, next_attempt_at, last_error)
         VALUES (?,?,?,?,?,?)`,
        [
          e.jmapAccountId,
          e.emailId,
          e.receivedAt,
          e.attempts,
          e.nextAttemptAt ?? null,
          e.lastError ?? null,
        ],
      );
    }
  }

  async updateBodyQueue(entries: BodyQueueEntry[]): Promise<void> {
    for (const e of entries) {
      await this.db.runAsync(
        `UPDATE body_queue SET attempts = ?, next_attempt_at = ?, last_error = ?
         WHERE jmap_account_id = ? AND email_id = ?`,
        [e.attempts, e.nextAttemptAt ?? null, e.lastError ?? null, e.jmapAccountId, e.emailId],
      );
    }
  }

  async dequeueBodies(keys: RowKey[]): Promise<void> {
    for (const k of keys) {
      await this.db.runAsync(
        'DELETE FROM body_queue WHERE jmap_account_id = ? AND email_id = ?',
        [k.jmapAccountId, k.id],
      );
    }
  }

  // ── state: field-level patches only (S1/I12) ──

  private async readState<T>(key: string): Promise<T | null> {
    const row = await this.db.getFirstAsync<{ v: string }>(
      'SELECT v FROM sync_state WHERE k = ?',
      [key],
    );
    if (!row) return null;
    return json<T | null>(row.v, null, key);
  }

  private async writeState(key: string, value: unknown): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO sync_state (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      [key, JSON.stringify(value)],
    );
  }

  async advanceCursor(key: CursorKey, next: ChangesState): Promise<void> {
    const k = cursorStateKey(key.jmapAccountId, key.type);
    const current = await this.readState<SyncCursor>(k);
    if (!current) {
      // A cursor is born from `seedCursor` and nowhere else (I2/I3). Creating one
      // here would be a silent cursor-from-nowhere, which is the class of bug
      // the branded types exist to make impossible.
      throw new Error(
        `advanceCursor: no cursor for ${key.type}/${key.jmapAccountId}; seed it first (§3.2)`,
      );
    }
    await this.writeState(k, {
      ...current,
      state: next,
      updatedAt: Date.now(),
    } satisfies SyncCursor);
  }

  async seedCursor(key: CursorKey, commitment: EnumerationCommitment): Promise<void> {
    if (commitment.jmapAccountId !== key.jmapAccountId) {
      throw new Error('seedCursor: commitment is for a different JMAP account');
    }
    const cursorK = cursorStateKey(key.jmapAccountId, key.type);
    const seeded: SyncCursor = {
      type: key.type,
      jmapAccountId: key.jmapAccountId,
      state: commitment.snapshot,
      drainPending: false,
      consecutiveFailures: 0,
      maxChangesRung: 0,
      updatedAt: Date.now(),
    };
    await this.writeState(cursorK, seeded);

    // Same transaction, so a seed is never durable without the durable
    // commitment to enumerate that justifies it (§3.2, §4.1 step 1).
    const coverageK = coverageStateKey(key.jmapAccountId);
    const existing = await this.readState<CoverageState>(coverageK);
    const next: CoverageState = {
      jmapAccountId: key.jmapAccountId,
      // Records stay readable during a reconcile, so what was already covered
      // stays claimed until step 5 sets it to the pinned floor.
      coveredFrom: existing?.coveredFrom ?? null,
      scanCursor: null,
      targetFrom: commitment.targetFrom,
      sweepFloor: commitment.sweepFloor,
      deferredTargetFrom: undefined,
      gapMarkers: existing?.gapMarkers,
      phase: coveragePhaseForCommitment(commitment),
      seen: 0,
      consecutiveFailures: 0,
      updatedAt: Date.now(),
    };
    await this.writeState(coverageK, next);
  }

  async patchCursor(
    key: CursorKey,
    patch: Partial<Omit<SyncCursor, 'type' | 'jmapAccountId' | 'state'>>,
  ): Promise<void> {
    const k = cursorStateKey(key.jmapAccountId, key.type);
    const current = await this.readState<SyncCursor>(k);
    if (!current) {
      throw new Error(`patchCursor: no cursor for ${key.type}/${key.jmapAccountId}`);
    }
    await this.writeState(k, { ...current, ...patch, updatedAt: Date.now() });
  }

  async patchCoverage(
    jmapAccountId: JmapAccountId,
    patch: Partial<CoverageState>,
  ): Promise<void> {
    if (patch.jmapAccountId !== undefined && patch.jmapAccountId !== jmapAccountId) {
      throw new Error('patchCoverage: patch may not re-key the coverage row');
    }
    const k = coverageStateKey(jmapAccountId);
    const current = await this.readState<CoverageState>(k);
    if (!current) {
      // Coverage exists only alongside a durably-committed enumeration, so there
      // is nothing to patch before the first `seedCursor` (§3.2).
      throw new Error(`patchCoverage: no coverage row for ${jmapAccountId}; seed it first`);
    }
    await this.writeState(k, { ...current, ...patch, jmapAccountId, updatedAt: Date.now() });
  }

  async patchAccountFlags(patch: AccountFlagsPatch): Promise<void> {
    const current = (await this.readState<StoredFlags>(FLAGS_KEY)) ?? defaultFlags();
    await this.writeState(FLAGS_KEY, { ...current, ...patch });
  }
}

interface StoredFlags {
  schemaVersion: number;
  resyncRequired: boolean;
  reconcilesInWindow: number;
  reconcileWindowStartedAt: number;
  lastWindowFloor?: string;
  lastCycle?: LastCycle;
}

function defaultFlags(): StoredFlags {
  return {
    schemaVersion: SCHEMA_VERSION,
    resyncRequired: false,
    reconcilesInWindow: 0,
    reconcileWindowStartedAt: 0,
  };
}

function emptyAccountState(): AccountSyncState {
  return { ...defaultFlags(), cursors: [], coverage: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

class SqliteStore implements SyncStore {
  private db: SqliteDriver | null = null;
  private readonly mutex = new Mutex();
  private epochAtOpen: number;
  private materialised: boolean;

  constructor(
    readonly accountId: LocalAccountId,
    private readonly host: SqliteHost,
    private readonly registry: SyncRegistry,
    private readonly factory: SqliteStoreFactory,
    epoch: number,
    materialised: boolean,
  ) {
    this.epochAtOpen = epoch;
    this.materialised = materialised;
  }

  get epoch(): number {
    return this.epochAtOpen;
  }

  /** Adopted by the store that performs the bump (see `clearRecords`). */
  private adoptEpoch(next: number): void {
    this.epochAtOpen = next;
  }

  private async assertEpoch(): Promise<void> {
    const current = await this.registry.epochFor(this.accountId);
    if (current !== this.epochAtOpen) {
      throw new EpochMismatchError(this.accountId, this.epochAtOpen, current);
    }
  }

  private async openDb(): Promise<SqliteDriver> {
    if (!this.db) {
      this.db = await this.host.open(databaseNameFor(this.accountId));
      for (const statement of SCHEMA_STATEMENTS) await this.db.execAsync(statement);
    }
    return this.db;
  }

  /**
   * §9.5: `open()` must not create a database file for an account whose offline
   * caching is disabled, so a read on a store that was never written creates
   * nothing and reports empty.
   */
  private async dbForRead(): Promise<SqliteDriver | null> {
    if (!this.materialised) return null;
    return this.openDb();
  }

  private async dbForWrite(): Promise<SqliteDriver> {
    const db = await this.openDb();
    if (!this.materialised) {
      // Written LAST when materialising (§8.4.1), so a crash between creating
      // the file and this line leaves a MISSING marker — which the launch
      // comparison treats as a mismatch and purges. Safe by default.
      await this.registry.writeFormatMarker(this.accountId, {
        storeFormat: STORE_FORMAT,
        schemaVersion: SCHEMA_VERSION,
      });
      this.materialised = true;
    }
    return db;
  }

  async loadAccountState(): Promise<AccountSyncState> {
    const db = await this.dbForRead();
    if (!db) return emptyAccountState();
    const rows = await db.getAllAsync<{ k: string; v: string }>(
      'SELECT k, v FROM sync_state',
      [],
    );
    const cursors: SyncCursor[] = [];
    const coverage: CoverageState[] = [];
    let flags = defaultFlags();
    for (const row of rows) {
      // A parse failure raises CorruptStateError; the caller applies I13
      // (resyncRequired + every cursor invalidated) rather than falling back to
      // empty cursors, which would leave unverified pre-existing records that no
      // sweep ever visits (F43).
      if (row.k === FLAGS_KEY) {
        flags = json<StoredFlags>(row.v, defaultFlags(), row.k);
      } else if (row.k.startsWith('cursor:')) {
        cursors.push(jsonRequired<SyncCursor>(row.v, row.k));
      } else if (row.k.startsWith('coverage:')) {
        coverage.push(jsonRequired<CoverageState>(row.v, row.k));
      }
    }
    return { ...flags, cursors, coverage };
  }

  async transaction<T>(fn: (txn: SyncTxn) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      await this.assertEpoch();
      const db = await this.dbForWrite();
      await db.execAsync('BEGIN IMMEDIATE');
      try {
        const out = await fn(new SqliteTxn(db));
        // §8.3: re-validate before the commit lands, not just at cycle start —
        // a cycle is long-lived and `switchAccount` can land in the middle of it.
        // Inside the transaction, so a mismatch rolls the whole thing back.
        await this.assertEpoch();
        await db.execAsync('COMMIT');
        return out;
      } catch (err) {
        try {
          await db.execAsync('ROLLBACK');
        } catch {
          // A failed ROLLBACK must not mask the original failure.
        }
        throw err;
      }
    });
  }

  // ── reads ──

  private async membershipFor(
    db: SqliteDriver,
    jmapAccountId: string,
    ids: string[],
  ): Promise<Map<string, Record<string, boolean>>> {
    const out = new Map<string, Record<string, boolean>>();
    for (const id of ids) out.set(id, {});
    for (const group of chunk(ids)) {
      const placeholders = group.map(() => '?').join(',');
      const rows = await db.getAllAsync<{ email_id: string; mailbox_id: string }>(
        `SELECT email_id, mailbox_id FROM email_mailbox
         WHERE jmap_account_id = ? AND email_id IN (${placeholders})`,
        [jmapAccountId, ...group],
      );
      for (const r of rows) {
        const bucket = out.get(r.email_id);
        if (bucket) bucket[r.mailbox_id] = true;
      }
    }
    return out;
  }

  async getEnvelope(key: RowKey): Promise<EnvelopeRow | null> {
    const db = await this.dbForRead();
    if (!db) return null;
    const row = await db.getFirstAsync<EnvelopeSqlRow>(
      'SELECT * FROM envelope WHERE jmap_account_id = ? AND id = ?',
      [key.jmapAccountId, key.id],
    );
    if (!row) return null;
    const membership = await this.membershipFor(db, key.jmapAccountId, [key.id]);
    return toEnvelopeRow(row, membership.get(key.id) ?? {});
  }

  async whichEnvelopesExist(keys: RowKey[]): Promise<RowKey[]> {
    const db = await this.dbForRead();
    if (!db || !keys.length) return [];
    const byAccount = new Map<string, string[]>();
    for (const k of keys) {
      const list = byAccount.get(k.jmapAccountId);
      if (list) list.push(k.id);
      else byAccount.set(k.jmapAccountId, [k.id]);
    }
    const found: RowKey[] = [];
    for (const [jmapAccountId, ids] of byAccount) {
      for (const group of chunk(ids)) {
        const placeholders = group.map(() => '?').join(',');
        const rows = await db.getAllAsync<{ id: string }>(
          `SELECT id FROM envelope WHERE jmap_account_id = ? AND id IN (${placeholders})`,
          [jmapAccountId, ...group],
        );
        for (const r of rows) found.push({ jmapAccountId, id: r.id });
      }
    }
    return found;
  }

  async getBody(key: RowKey): Promise<BodyRow | null> {
    const db = await this.dbForRead();
    if (!db) return null;
    const row = await db.getFirstAsync<{
      jmap_account_id: string;
      email_id: string;
      received_at: string;
      json: string;
      bytes: number;
    }>('SELECT * FROM body WHERE jmap_account_id = ? AND email_id = ?', [
      key.jmapAccountId,
      key.id,
    ]);
    if (!row) return null;
    return {
      jmapAccountId: row.jmap_account_id,
      emailId: row.email_id,
      receivedAt: row.received_at,
      json: row.json,
      bytes: row.bytes,
    };
  }

  async listMailboxes(jmapAccountId: JmapAccountId): Promise<MailboxRow[]> {
    const db = await this.dbForRead();
    if (!db) return [];
    const rows = await db.getAllAsync<MailboxSqlRow>(
      'SELECT * FROM mailbox WHERE jmap_account_id = ? ORDER BY sort_order, name',
      [jmapAccountId],
    );
    return rows.map(toMailboxRow);
  }

  /**
   * The index seek that actually closes D3. `mailboxId` joins `email_mailbox`
   * (covered by `email_mailbox_by_mailbox`), so a sparse or empty folder costs an
   * index probe instead of parsing every cached entry.
   *
   * `receivedAfter` is INCLUSIVE and `receivedBefore` EXCLUSIVE, mirroring
   * RFC 8621 §4.4.1's `after`/`before` so the coverage scan's keyset walk means
   * the same thing locally as it does on the server (S14).
   */
  async queryEnvelopes(q: EnvelopeQuery): Promise<EnvelopeRow[]> {
    const db = await this.dbForRead();
    if (!db) return [];
    const params: Array<string | number> = [];
    let sql = 'SELECT e.* FROM envelope e';
    if (q.mailboxId !== undefined) {
      sql +=
        ' JOIN email_mailbox m ON m.jmap_account_id = e.jmap_account_id' +
        ' AND m.email_id = e.id AND m.mailbox_id = ?';
      params.push(q.mailboxId);
    }
    sql += ' WHERE e.jmap_account_id = ?';
    params.push(q.jmapAccountId);
    if (q.receivedBefore !== undefined) {
      sql += ' AND e.received_at < ?';
      params.push(q.receivedBefore);
    }
    if (q.receivedAfter !== undefined) {
      sql += ' AND e.received_at >= ?';
      params.push(q.receivedAfter);
    }
    if (q.cachedBefore !== undefined) {
      sql += ' AND e.cached_at < ?';
      params.push(q.cachedBefore);
    }
    if (q.hasBody !== undefined) {
      sql += ' AND e.has_body = ?';
      params.push(q.hasBody ? 1 : 0);
    }
    sql += ' ORDER BY e.received_at DESC, e.id ASC LIMIT ?';
    params.push(q.limit);
    if (q.offset !== undefined) {
      sql += ' OFFSET ?';
      params.push(q.offset);
    }
    const rows = await db.getAllAsync<EnvelopeSqlRow>(sql, params);
    const membership = await this.membershipFor(
      db,
      q.jmapAccountId,
      rows.map((r) => r.id),
    );
    return rows.map((r) => toEnvelopeRow(r, membership.get(r.id) ?? {}));
  }

  async countEnvelopes(q?: { jmapAccountId?: JmapAccountId; mailboxId?: string }): Promise<number> {
    const db = await this.dbForRead();
    if (!db) return 0;
    const params: string[] = [];
    let sql = 'SELECT count(*) AS c FROM envelope e';
    const where: string[] = [];
    if (q?.mailboxId !== undefined) {
      sql +=
        ' JOIN email_mailbox m ON m.jmap_account_id = e.jmap_account_id' +
        ' AND m.email_id = e.id AND m.mailbox_id = ?';
      params.push(q.mailboxId);
    }
    if (q?.jmapAccountId !== undefined) {
      where.push('e.jmap_account_id = ?');
      params.push(q.jmapAccountId);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    const row = await db.getFirstAsync<{ c: number }>(sql, params);
    return row?.c ?? 0;
  }

  async bodyBytesTotal(): Promise<number> {
    const db = await this.dbForRead();
    if (!db) return 0;
    const row = await db.getFirstAsync<{ total: number }>(
      'SELECT COALESCE(SUM(bytes), 0) AS total FROM body',
      [],
    );
    return row?.total ?? 0;
  }

  /** Single-table ordered scan over `body.received_at` (S12) — no join to blind it. */
  async listBodiesForEviction(
    limit: number,
  ): Promise<Array<{ key: RowKey; receivedAt: string; bytes: number }>> {
    const db = await this.dbForRead();
    if (!db) return [];
    const rows = await db.getAllAsync<{
      jmap_account_id: string;
      email_id: string;
      received_at: string;
      bytes: number;
    }>(
      `SELECT jmap_account_id, email_id, received_at, bytes FROM body
       ORDER BY received_at ASC, email_id ASC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      key: { jmapAccountId: r.jmap_account_id, id: r.email_id },
      receivedAt: r.received_at,
      bytes: r.bytes,
    }));
  }

  /** F45: otherwise orphans consume the user's storage cap while invisible to eviction. */
  async listOrphanBodies(limit: number): Promise<RowKey[]> {
    const db = await this.dbForRead();
    if (!db) return [];
    const rows = await db.getAllAsync<{ jmap_account_id: string; email_id: string }>(
      `SELECT b.jmap_account_id, b.email_id FROM body b
       LEFT JOIN envelope e ON e.jmap_account_id = b.jmap_account_id AND e.id = b.email_id
       WHERE e.id IS NULL
       ORDER BY b.received_at ASC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({ jmapAccountId: r.jmap_account_id, id: r.email_id }));
  }

  async takeBodyQueue(limit: number, now: number): Promise<BodyQueueEntry[]> {
    const db = await this.dbForRead();
    if (!db) return [];
    const rows = await db.getAllAsync<{
      jmap_account_id: string;
      email_id: string;
      received_at: string;
      attempts: number;
      next_attempt_at: number | null;
      last_error: string | null;
    }>(
      `SELECT * FROM body_queue
       WHERE next_attempt_at IS NULL OR next_attempt_at <= ?
       ORDER BY received_at DESC, email_id ASC LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => ({
      jmapAccountId: r.jmap_account_id,
      emailId: r.email_id,
      receivedAt: r.received_at,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at ?? undefined,
      lastError: r.last_error ?? undefined,
    }));
  }

  /**
   * Records + body queue (S12), NOT cursors (§7.5 rule 7). The epoch bump comes
   * FIRST so an in-flight cycle cannot land between the wipe and the bump and
   * revive `resyncRequired: false` over it (F35/F37) — the broken sequence S1
   * describes. This store adopts the new epoch, since it is the one performing
   * the mutation.
   */
  async clearRecords(): Promise<void> {
    const next = await this.registry.bumpEpoch(this.accountId, 'clearRecords');
    this.adoptEpoch(next);
    await this.transaction(async (txn) => {
      const db = await this.openDb();
      for (const table of RECORD_TABLES) await db.execAsync(`DELETE FROM ${table}`);
      await txn.patchAccountFlags({ resyncRequired: true });
    });
  }

  async purge(): Promise<void> {
    await this.factory.purgeAccount(this.accountId, 'removed');
  }

  /** Drops this store's handle so a purge can delete the file underneath it. */
  async closeForPurge(): Promise<void> {
    if (this.db) {
      await this.db.closeAsync();
      this.db = null;
    }
    this.materialised = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export class SqliteStoreFactory implements SyncStoreFactory {
  private readonly open_: Map<LocalAccountId, SqliteStore> = new Map();

  constructor(
    private readonly host: SqliteHost = expoSqliteHost,
    private readonly registry: SyncRegistry = syncRegistry,
  ) {}

  async open(accountId: LocalAccountId): Promise<SyncStore> {
    const existing = this.open_.get(accountId);
    if (existing) return existing;
    const epoch = await this.registry.epochFor(accountId);
    const materialised = await this.isMaterialised(accountId);
    const store = new SqliteStore(
      accountId,
      this.host,
      this.registry,
      this,
      epoch,
      materialised,
    );
    this.open_.set(accountId, store);
    return store;
  }

  /** So Settings can show accurate storage stats without creating anything (§9.5). */
  async isMaterialised(accountId: LocalAccountId): Promise<boolean> {
    return (await this.readFormatMarker(accountId)) !== null;
  }

  listAccounts(): Promise<LocalAccountId[]> {
    return this.registry.listAccounts();
  }

  epochFor(accountId: LocalAccountId): Promise<number> {
    return this.registry.epochFor(accountId);
  }

  bumpEpoch(accountId: LocalAccountId, reason: string): Promise<number> {
    return this.registry.bumpEpoch(accountId, reason);
  }

  readFormatMarker(accountId: LocalAccountId): Promise<StoreFormatMarker | null> {
    return this.registry.readFormatMarker(accountId);
  }

  writeFormatMarker(accountId: LocalAccountId, marker: StoreFormatMarker): Promise<void> {
    return this.registry.writeFormatMarker(accountId, marker);
  }

  /**
   * §8.4, in this order for a reason:
   *   1. tombstone FIRST, so a crash anywhere after it is recoverable — a store
   *      missing arbitrary records while holding a live cursor is the worst
   *      possible state, and step 1 makes it unreachable.
   *   2. epoch bump, so every in-flight cycle's next commit is rejected.
   *   3. [once encrypted] delete the SQLCipher key BEFORE the file, so an
   *      interrupted purge leaves UNREADABLE data rather than readable data.
   *      Not reachable yet: plain SQLite has no key (§14.3 step 3.7).
   *   4. delete the database file.
   *   5. remove the registry entry — keeping the epoch (§8.3).
   */
  async purgeAccount(accountId: LocalAccountId, _reason: PurgeReason): Promise<void> {
    await this.registry.markPurgePending(accountId);
    await this.registry.bumpEpoch(accountId, `purge:${_reason}`);
    const store = this.open_.get(accountId);
    if (store) {
      await store.closeForPurge();
      this.open_.delete(accountId);
    }
    await this.host.delete(databaseNameFor(accountId));
    await this.registry.completePurge(accountId);
  }

  /**
   * Once at launch, BEFORE any cycle starts. Completes pending purges and purges
   * any account whose recorded `(storeFormat, schemaVersion)` disagrees with what
   * this build expects (§8.4.1). A missing marker counts as a mismatch, which is
   * what makes a crash mid-materialisation safe by default.
   */
  async completePendingPurges(): Promise<void> {
    for (const entry of await this.registry.listEntries()) {
      if (entry.purgePending) {
        await this.purgeAccount(entry.accountId, 'removed');
        continue;
      }
      // An entry with no store at all is not a mismatch — there is nothing to
      // purge and nothing to read; it bootstraps (§4).
      if (entry.storeFormat === undefined && entry.schemaVersion === undefined) continue;
      if (entry.storeFormat !== STORE_FORMAT || entry.schemaVersion !== SCHEMA_VERSION) {
        await this.purgeAccount(entry.accountId, 'store-format-change');
      }
    }
  }
}

export const sqliteStoreFactory = new SqliteStoreFactory();
