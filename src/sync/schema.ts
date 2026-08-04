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
 */
export const SCHEMA_VERSION = 1;

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

  `CREATE TABLE IF NOT EXISTS body_queue (
     jmap_account_id TEXT NOT NULL, email_id TEXT NOT NULL, received_at TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error TEXT,
     PRIMARY KEY (jmap_account_id, email_id)
   )`,

  // Cursors, coverage, flags. Row-per-field so §9.1's patches are genuinely
  // field-level (I12) rather than a read-modify-write of one big blob.
  `CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];

/** The tables `clearRecords()` wipes: records + the body queue (S12), NOT sync_state. */
export const RECORD_TABLES: readonly string[] = [
  'envelope',
  'email_mailbox',
  'body',
  'body_queue',
  'mailbox',
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
