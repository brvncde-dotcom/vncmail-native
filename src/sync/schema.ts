// The §9.3 schema, verbatim from the design (revision 2's account-scoped keys,
// the S3 fix). Every primary key includes `jmap_account_id`.
//
// Deliberately NO foreign keys from `email_mailbox.mailbox_id` -> `mailbox`, and
// no cascade from `envelope`. Per §5.5 the two change streams are not
// transactionally coupled, so a membership row referencing a not-yet-fetched or
// already-destroyed mailbox is a normal transient state; an FK would turn correct
// behaviour into a constraint violation, and a cascade on mailbox deletion would
// delete mail, violating I7. Body/envelope consistency is maintained by
// `putBodyIfEnvelopeExists` + `deleteEmails` + the orphan sweep (F45), not by the
// schema.
//
// `sync_state` sitting in the same file as the records is what makes §8.4's
// atomic wipe work: deleting the file removes cursors and records together, so a
// cursor can never survive a wipe and then be advanced over changes that will
// never be re-delivered.

/**
 * Bumped for any breaking change to the statements below. A mismatch against the
 * registry's mirrored value purges and re-bootstraps (§8.4.1) — §14.1 already
 * specifies discard-and-rebuild, so there is no migration path to maintain.
 *
 * v3 adds the `fts` virtual table (§9.4 step-9 hook) — no migration needed, the
 * bump alone purges and re-bootstraps every account, which repopulates it via the
 * normal C1/C2 body-fetch jobs.
 */
export const SCHEMA_VERSION = 3;

/** Plain expo-sqlite. `sqlite-cipher` is the later, human-gated flip (§14.3 step 3.7). */
export const STORE_FORMAT = 'sqlite-plain' as const;

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS mailbox (
     jmap_account_id TEXT NOT NULL, id TEXT NOT NULL,
     name TEXT NOT NULL, parent_id TEXT, role TEXT, sort_order INTEGER,
     total_emails INTEGER, unread_emails INTEGER, total_threads INTEGER, unread_threads INTEGER,
     my_rights TEXT, is_subscribed INTEGER,
     PRIMARY KEY (jmap_account_id, id)
   )`,

  `CREATE TABLE IF NOT EXISTS envelope (
     jmap_account_id TEXT NOT NULL, id TEXT NOT NULL,
     thread_id TEXT, received_at TEXT NOT NULL, size INTEGER,
     subject TEXT, preview TEXT, from_json TEXT, to_json TEXT, cc_json TEXT,
     has_attachment INTEGER, keywords_json TEXT NOT NULL,
     has_body INTEGER NOT NULL DEFAULT 0, body_bytes INTEGER NOT NULL DEFAULT 0,
     cached_at INTEGER NOT NULL,
     PRIMARY KEY (jmap_account_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS envelope_received ON envelope(jmap_account_id, received_at DESC)`,
  // Job C2's driver (S9): envelopes inside the body window with no body yet.
  `CREATE INDEX IF NOT EXISTS envelope_nobody ON envelope(jmap_account_id, has_body, received_at DESC)`,

  // Membership is its own table: an email is in many mailboxes, and listing by
  // folder must be an index seek, not a scan of every cached body (D3).
  `CREATE TABLE IF NOT EXISTS email_mailbox (
     jmap_account_id TEXT NOT NULL, email_id TEXT NOT NULL, mailbox_id TEXT NOT NULL,
     PRIMARY KEY (jmap_account_id, email_id, mailbox_id)
   )`,
  `CREATE INDEX IF NOT EXISTS email_mailbox_by_mailbox ON email_mailbox(jmap_account_id, mailbox_id)`,

  // S12: received_at lives here too, so eviction is a single-table ordered scan
  // and cannot be blinded by a missing/failed join to envelope.
  `CREATE TABLE IF NOT EXISTS body (
     jmap_account_id TEXT NOT NULL, email_id TEXT NOT NULL,
     received_at TEXT NOT NULL, json TEXT NOT NULL, bytes INTEGER NOT NULL,
     PRIMARY KEY (jmap_account_id, email_id)
   )`,
  `CREATE INDEX IF NOT EXISTS body_received ON body(jmap_account_id, received_at ASC)`,

  // `gave_up` is what makes a body-tier TERMINAL STATE durable. Deleting the row on
  // give-up was not enough: job C2's driver is `queryEnvelopes({hasBody: false})`,
  // which cannot tell "not fetched yet" from "deliberately not kept", so the next
  // pass re-inserted a fresh `attempts: 0` row and a permanently-failing body retried
  // five times per cycle, forever. Keeping the row with a flag is what closes that.
  `CREATE TABLE IF NOT EXISTS body_queue (
     jmap_account_id TEXT NOT NULL, email_id TEXT NOT NULL, received_at TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error TEXT,
     gave_up INTEGER NOT NULL DEFAULT 0, gave_up_reason TEXT,
     PRIMARY KEY (jmap_account_id, email_id)
   )`,
  // The C1 driver: rows still wanted, cheapest to find by the flag.
  `CREATE INDEX IF NOT EXISTS body_queue_wanted ON body_queue(jmap_account_id, gave_up, received_at DESC)`,

  // Cursors, coverage, flags. Row-per-field so §9.1's patches are genuinely
  // field-level (I12) rather than a read-modify-write of one big blob.
  `CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,

  // §9.4 step-9 hook. `jmap_account_id`/`email_id` are UNINDEXED — plain columns
  // carried alongside the indexed text, not part of the compound PK every other
  // table uses (FTS5 has no notion of a composite key; external-content/rowid
  // mode wants a single integer rowid, which nothing here has). Filtering is
  // `WHERE jmap_account_id = ?`; `bm25()` scores only the indexed columns, so
  // these two never affect ranking. Populated by `upsertFtsRow`/`deleteFtsRows`
  // in fts.ts, called from `upsertEnvelopes`, `putBodyIfEnvelopeExists`,
  // `deleteEmails`, `deleteBodies` — the only write paths for indexable content.
  `CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
     jmap_account_id UNINDEXED,
     email_id UNINDEXED,
     subject,
     preview,
     body
   )`,
];

/**
 * The tables `clearRecords()` wipes: records + the body queue (S12), NOT sync_state.
 *
 * `fts` belongs here too, not just on `purgeAccount`'s file delete: `clearRecords()`
 * runs `DELETE FROM` per table against the *same open database file* (a forced
 * resync, not a purge), so a stale `fts` row would otherwise survive it and could
 * outlive the message it indexed if that message was deleted upstream during the
 * resync gap — `DELETE FROM fts` is valid on a virtual table, same as any other.
 */
export const RECORD_TABLES: readonly string[] = [
  'envelope',
  'email_mailbox',
  'body',
  'body_queue',
  'mailbox',
  'fts',
];

// ── sync_state key layout ──

export const FLAGS_KEY = 'flags';

export function cursorStateKey(jmapAccountId: string, type: string): string {
  return `cursor:${jmapAccountId}:${type}`;
}

export function coverageStateKey(jmapAccountId: string): string {
  return `coverage:${jmapAccountId}`;
}

/**
 * One SQLite file per local account. `generateAccountId()` yields
 * `username@host`, which contains characters that are legal in a filename but
 * awkward, so encode rather than interpolate raw.
 */
export function databaseNameFor(accountId: string): string {
  return `vncmail-sync-${encodeURIComponent(accountId)}.db`;
}
