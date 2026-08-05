// The read-time local-mutation overlay of §5.6 (S11's fix, revised).
//
// Revision 1 had the engine re-apply pending outbox ops on top of each delta, and
// named no owner for writing optimistic mutations into the durable store — leaving
// a reachable sequence that lost a local mutation silently until restart. Rather
// than making that write-through atomic, revision 2 REMOVED the write path:
//
//   * the durable store holds server-derived state only — nothing optimistic is
//     ever written into `envelope`/`body`;
//   * `outbox-store` is the sole durable record of local intent (which is why
//     §5.6.1's durability fix had to land first);
//   * reads compose the two through this module;
//   * `apply()` never sees pending ops, so the delta path has no way to be wrong
//     about them.
//
// Why that is better than an atomic write-through: it needs no cross-store
// transaction, it cannot lose a mutation because the only durable copy is the one
// the outbox already wrote, and it DELETES the "delta reverts the user's offline
// change" failure mode instead of guarding it (F28). After a flush the server
// converges and the op leaves the queue, so the overlay disappears on its own.
//
// Everything here is pure: no network, no storage, no Zustand. The pending ops are
// a PARAMETER, never a store read from inside this module (S11).

/**
 * The subset of `OutboxOp` this module needs. Declared structurally rather than
 * imported so `overlay.ts` stays free of a store dependency (§10.5) — and so the
 * §11 cases are testable as plain data.
 */
export type PendingOp =
  | { kind: 'keywords'; emailId: string; accountId?: string; keywords: Record<string, boolean> }
  | { kind: 'mailboxes'; emailId: string; accountId?: string; mailboxIds: Record<string, boolean> }
  | { kind: 'destroy'; emailId: string; accountId?: string };

/** The shape the overlay can adjust: anything carrying the two mutable properties. */
export interface OverlayableRecord {
  id: string;
  keywords?: Record<string, boolean>;
  mailboxIds?: Record<string, boolean>;
}

/**
 * Pending ops indexed by email id — what §12.3's outbox selector supplies. Built
 * once per read rather than scanned per row, since the read paths are on the
 * offline list's critical path.
 */
export type PendingIndex = Map<string, PendingOp[]>;

export function indexPendingOps(ops: readonly PendingOp[]): PendingIndex {
  const index: PendingIndex = new Map();
  for (const op of ops) {
    const bucket = index.get(op.emailId);
    if (bucket) bucket.push(op);
    else index.set(op.emailId, [op]);
  }
  return index;
}

/**
 * Apply pending intent to one server-truth record.
 *
 * Returns `null` when a queued `destroy` should hide the record from reads. The
 * record is NOT deleted from the store — it is removed for real only when
 * `Email/changes` reports it `destroyed` (I7: deletion provenance).
 *
 * Ops are applied in queue order, which is the order the user made them, and each
 * primitive assigns the WHOLE target state rather than a delta (see
 * outbox-store's header), so last-write-wins is correct and replay-safe.
 */
export function applyPendingOps<T extends OverlayableRecord>(
  record: T,
  pending: readonly PendingOp[] | undefined,
): T | null {
  if (!pending || pending.length === 0) return record;

  let keywords = record.keywords;
  let mailboxIds = record.mailboxIds;
  let changed = false;

  for (const op of pending) {
    switch (op.kind) {
      case 'destroy':
        // F29: a pending destroy hides the record even if the delta path just
        // reported it created/updated. Server state is applied to the store; the
        // overlay hides it; the flush plus the subsequent `destroyed` removes it.
        return null;
      case 'keywords':
        keywords = { ...op.keywords };
        changed = true;
        break;
      case 'mailboxes':
        mailboxIds = { ...op.mailboxIds };
        changed = true;
        break;
    }
  }

  if (!changed) return record;
  return { ...record, keywords, mailboxIds };
}

/**
 * List form: overlay every row and drop the ones a pending destroy hides.
 *
 * Note this can shorten a page — a list of 50 with 2 pending destroys renders 48.
 * That is the correct visible behaviour and matches what `dropFromCache()` did
 * before, just without writing anything.
 */
export function applyPendingOpsToList<T extends OverlayableRecord>(
  records: readonly T[],
  pending: PendingIndex,
): T[] {
  if (pending.size === 0) return [...records];
  const out: T[] = [];
  for (const record of records) {
    const overlaid = applyPendingOps(record, pending.get(record.id));
    if (overlaid !== null) out.push(overlaid);
  }
  return out;
}

/**
 * Whether a body should be fetched for this message. F29: no body is enqueued for
 * a message with a pending destroy — it is about to be gone, and the download
 * would be pure waste.
 */
export function hasPendingDestroy(pending: readonly PendingOp[] | undefined): boolean {
  return Boolean(pending?.some((op) => op.kind === 'destroy'));
}

// ── What the overlay deliberately does NOT cover (§5.6.2) ──
//
// 1. UNREAD BADGE COUNTS. Every badge reads `Mailbox.unreadEmails`, a
//    SERVER-MAINTAINED SCALAR the engine patches from `Mailbox/get` (§5.2). A
//    per-email-record overlay structurally cannot correct a per-mailbox aggregate:
//    it has no way to know which of the mailbox's UNCACHED messages are unread, so
//    it cannot recompute the total. Maintaining a per-mailbox tally of pending
//    `$seen` transitions was considered and rejected for v1 — a second piece of
//    derived state to keep consistent with the queue (coalescing, attempt drops,
//    flush completion) for a cosmetic gain, where getting it wrong produces a
//    WRONG number rather than a stale one. So while offline, marking a message
//    read updates the row immediately and leaves the folder's unread count stale
//    until the outbox flushes. That is exactly today's behaviour — `patchCache()`
//    never touched mailbox counts either — so it is not a regression.
//
// 2. SQL-LEVEL PREDICATES. A query filtering on `keywords` (an offline unread
//    filter, or FTS in step 9) sees server truth; the overlay applies to rows
//    AFTER the query returns. Also a limitation, also not a silent-loss risk: the
//    durable copy of the intent is in the outbox either way.
