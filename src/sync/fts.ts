// The §9.4 step-9 hook: local full-text search over synced mail, backing the
// AI assistant's local retrieval leg (docs/AI-ASSISTANT-CONCEPT.md §7). SQLite-only,
// deliberately kept out of the `SyncStore` interface (store.ts) — FTS5 has no
// `MemoryStore` equivalent and nothing in the engine's own contract needs one.
//
// Two ideas carry the whole module:
//
//  1. THE FTS ROW IS ALWAYS REBUILT FROM CURRENT STATE, NEVER PATCHED. Subject
//     and body land at different times for the same message (`upsertEnvelopes`
//     first, `putBodyIfEnvelopeExists` later, sometimes much later). A write
//     path that only wrote its own slice would clobber whichever half the other
//     path already wrote. `upsertFtsRow` instead re-reads both source tables and
//     does a full delete+insert — always correct because it is authoritative
//     from tables that already committed, never a diff.
//
//  2. `jmap_account_id`/`email_id` ride along as UNINDEXED columns, not a rowid
//     mapping. Every real table here keys on the compound (jmap_account_id, id)
//     (S3, store.ts), which FTS5's external-content/rowid mode doesn't fit —
//     it wants one integer rowid to sync against. Plain unindexed columns
//     sidestep that: filtering is `WHERE jmap_account_id = ?`, no triggers, and
//     `bm25()` never scores them.

import type { SqliteDriver } from './sqlite-driver';

interface StoredBodyPart {
  partId?: string;
}

/** The shape `serialiseBody()` writes (bodies.ts) — only the fields used here. */
interface StoredBody {
  textBody?: StoredBodyPart[];
  htmlBody?: StoredBodyPart[];
  bodyValues?: Record<string, { value: string; isEncodingProblem?: boolean }>;
}

/**
 * Regex tag-strip, not a real parser. Unlike `email-html.ts` (which sanitises
 * HTML for on-screen display and has to get that right), this only needs to
 * turn markup into search tokens — losing structure is fine, leaking a `<script>`
 * body's contents into the index is not.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pulls indexable text out of a `body.json` blob. `textBody`/`htmlBody` are
 * only part references (`partId`) — the actual text lives in `bodyValues`,
 * keyed by that same `partId` (populated because the engine's own fetch sets
 * `fetchAllBodyValues: true`, jmap-port.ts -> email.ts:577-580). Plain text is
 * preferred; HTML is only stripped and used when no text part exists.
 */
export function extractBodyText(bodyJson: string): string {
  let parsed: StoredBody;
  try {
    parsed = JSON.parse(bodyJson) as StoredBody;
  } catch {
    return '';
  }
  const values = parsed.bodyValues ?? {};
  const fromParts = (parts?: StoredBodyPart[]): string =>
    (parts ?? [])
      .map((p) => (p.partId !== undefined ? values[p.partId]?.value : undefined))
      .filter((v): v is string => typeof v === 'string')
      .join('\n');

  const text = fromParts(parsed.textBody);
  if (text.trim()) return text;
  const html = fromParts(parsed.htmlBody);
  return html ? stripHtml(html) : '';
}

/**
 * FTS5's `MATCH` syntax is not `toWildcardQuery`'s (search-utils.ts) — that one
 * targets JMAP's `Email/query` text filter. FTS5 has its own reserved
 * characters (a bare leading `-` means NOT; unescaped punctuation can throw a
 * `MATCH` syntax error outright). Wrapping each word in double quotes with a
 * trailing `*` makes it a literal prefix term, which sidesteps the operator
 * surface without needing a real tokenizer.
 */
export function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `"${word.replace(/"/g, '""')}"*`)
    .join(' ');
}

async function currentEnvelopeText(
  db: SqliteDriver,
  jmapAccountId: string,
  id: string,
): Promise<{ subject: string | null; preview: string | null } | null> {
  return db.getFirstAsync<{ subject: string | null; preview: string | null }>(
    'SELECT subject, preview FROM envelope WHERE jmap_account_id = ? AND id = ?',
    [jmapAccountId, id],
  );
}

async function currentBodyText(
  db: SqliteDriver,
  jmapAccountId: string,
  id: string,
): Promise<string> {
  const row = await db.getFirstAsync<{ json: string }>(
    'SELECT json FROM body WHERE jmap_account_id = ? AND email_id = ?',
    [jmapAccountId, id],
  );
  return row ? extractBodyText(row.json) : '';
}

/**
 * Rebuilds the fts row for one message from the CURRENT state of `envelope`
 * and `body` — see the module header. A no-op if the envelope is already gone
 * (deletion is `deleteFtsRows`'s job, not this function's).
 */
export async function upsertFtsRow(
  db: SqliteDriver,
  jmapAccountId: string,
  id: string,
): Promise<void> {
  const envelope = await currentEnvelopeText(db, jmapAccountId, id);
  if (!envelope) return;
  const body = await currentBodyText(db, jmapAccountId, id);
  await db.runAsync('DELETE FROM fts WHERE jmap_account_id = ? AND email_id = ?', [
    jmapAccountId,
    id,
  ]);
  await db.runAsync(
    'INSERT INTO fts (jmap_account_id, email_id, subject, preview, body) VALUES (?,?,?,?,?)',
    [jmapAccountId, id, envelope.subject ?? '', envelope.preview ?? '', body],
  );
}

/** For `deleteEmails` — the message is gone, so its fts row goes with it. */
export async function deleteFtsRows(
  db: SqliteDriver,
  jmapAccountId: string,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    await db.runAsync('DELETE FROM fts WHERE jmap_account_id = ? AND email_id = ?', [
      jmapAccountId,
      id,
    ]);
  }
}

export interface FtsSearchOpts {
  /** Restrict to messages in any of these mailboxes. Omitted = no mailbox filter. */
  mailboxIds?: string[];
  /** Inclusive floor, matching `EnvelopeQuery.receivedAfter`'s RFC 8621 semantics. */
  receivedAfter?: string;
  limit?: number;
}

export interface FtsHit {
  id: string;
  /** `bm25()` — lower is more relevant. */
  score: number;
}

const DEFAULT_LIMIT = 60;
/**
 * The inner query's candidate pool, before mailbox/date filtering shrinks it.
 * Over-fetch-then-filter is the only option here (see the comment below on why
 * scoring can't happen in the same query level as the join) — generous enough
 * that a narrow mailbox scope still fills `limit`, bounded so a broad,
 * high-recall query can't turn into an unbounded scan.
 */
const CANDIDATE_MULTIPLIER = 4;
const MAX_CANDIDATES = 500;

/**
 * The local BM25 recall leg (docs/AI-ASSISTANT-CONCEPT.md §7, step 2).
 *
 * `bm25()` can only be evaluated while SQLite is looping directly over the
 * FTS5 cursor for its own `MATCH` — confirmed against node:sqlite: adding a
 * `JOIN` + `GROUP BY` at the same query level throws "unable to use function
 * bm25 in the requested context" the moment a row actually matches (a
 * zero-result MATCH never reaches the call, which is why this can look like
 * it works until a query actually finds something). The fix is the standard
 * FTS5 idiom: score in an inner subquery with nothing but the MATCH itself,
 * then join/filter/group in an outer query over the now-materialised score
 * column, mirroring `queryEnvelopes`'s incremental-clause style at that outer
 * level.
 */
export async function ftsSearchRows(
  db: SqliteDriver,
  jmapAccountId: string,
  query: string,
  opts: FtsSearchOpts = {},
): Promise<FtsHit[]> {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const candidatePool = Math.min(limit * CANDIDATE_MULTIPLIER, MAX_CANDIDATES);

  const innerParams: Array<string | number> = [jmapAccountId, ftsQuery, candidatePool];
  const innerSql =
    'SELECT fts.email_id AS id, bm25(fts) AS score FROM fts' +
    ' WHERE fts.jmap_account_id = ? AND fts MATCH ?' +
    ' ORDER BY score ASC LIMIT ?';

  const params: Array<string | number> = [...innerParams, jmapAccountId];
  let sql =
    `SELECT s.id, s.score FROM (${innerSql}) s` +
    ' JOIN envelope e ON e.jmap_account_id = ? AND e.id = s.id';

  if (opts.mailboxIds && opts.mailboxIds.length > 0) {
    sql +=
      ' JOIN email_mailbox m ON m.jmap_account_id = ?' +
      ` AND m.email_id = s.id AND m.mailbox_id IN (${opts.mailboxIds.map(() => '?').join(',')})`;
    params.push(jmapAccountId, ...opts.mailboxIds);
  }

  if (opts.receivedAfter !== undefined) {
    sql += ' WHERE e.received_at >= ?';
    params.push(opts.receivedAfter);
  }

  // A message can sit in more than one scoped mailbox, duplicating the join;
  // GROUP BY collapses that. `s.score` is a plain column at this level (the
  // inner subquery already computed it), so grouping it here is unremarkable
  // — this is no longer the aux-function-in-context problem the inner query
  // has to avoid.
  sql += ' GROUP BY s.id ORDER BY s.score ASC LIMIT ?';
  params.push(limit);

  return db.getAllAsync<FtsHit>(sql, params);
}
