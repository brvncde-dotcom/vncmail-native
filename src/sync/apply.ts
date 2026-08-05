// PURE change application (design §5.2–§5.4). No network, no storage, no Zustand.
//
// §2.2 makes this a hard requirement, and it is the reason most of §11's
// failure-mode table becomes a test suite rather than a promise: every rule about
// what a `/changes` page does to local state is expressible as
// `plan(page, fetched) -> mutations` and assertable as plain data.
//
// The jobs in `delta.ts` do the fetching and the committing; nothing in this file
// knows how either happens.

import { EMAIL_MUTABLE_PROPERTIES } from '../api/email';
import type { Email, Mailbox } from '../api/types';
import { hasPendingDestroy, type PendingIndex } from './overlay';
import type {
  BodyQueueEntry,
  EnvelopeRow,
  MailboxCounts,
  MailboxRow,
  RowKey,
} from './store';
import type { ChangesState, JmapAccountId } from './states';

/**
 * A `Foo/changes` page, in the shape both api wrappers already return.
 *
 * `oldState`/`newState` are `ChangesState`, not `string`: that is what lets
 * `advanceCursor(key, page.newState)` compile with NO cast, which §6.3 requires —
 * an `as ChangesState` cast is precisely the escape hatch that defeats the brand.
 */
export interface ChangesPage {
  oldState: ChangesState;
  newState: ChangesState;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// §5.4 Ordering within one page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RFC 8620 §5.2 permits overlap between the three arrays: a record created AND
 * updated since the old state SHOULD appear only in `created` but MAY also appear
 * in `updated`, and updated+destroyed collapses to `destroyed`. Created+destroyed
 * SHOULD be omitted entirely but is not forbidden.
 *
 * Rule: within a page, apply CREATES, then UPDATES, then DESTROYS. Because ids are
 * never reused (RFC 8620 §1.2), a destroy always refers to the same record as any
 * create/update of that id in the same page, so destroy-last converges on the
 * correct final state. The reverse order would resurrect a dead id, spend a fetch,
 * and get `notFound`.
 *
 * This function normalises the page so downstream code cannot get the order wrong
 * by iterating the arrays in the order the server happened to send them.
 */
export function normalisePage(page: ChangesPage): {
  created: string[];
  updated: string[];
  destroyed: string[];
} {
  const destroyed = [...new Set(page.destroyed)];
  const destroyedSet = new Set(destroyed);
  // An id in `destroyed` wins outright: fetching it would be wasted and the
  // result would be `notFound`.
  const created = [...new Set(page.created)].filter((id) => !destroyedSet.has(id));
  const createdSet = new Set(created);
  // An id in both `created` and `updated` is a create — the create path fetches
  // the full envelope tier, which already includes the updated values.
  const updated = [...new Set(page.updated)].filter(
    (id) => !destroyedSet.has(id) && !createdSet.has(id),
  );
  return { created, updated, destroyed };
}

/** An empty page still advances the cursor (§7.5 rule 4) — skipping it re-requests forever. */
export function pageIsEmpty(page: ChangesPage): boolean {
  return (
    page.created.length === 0 && page.updated.length === 0 && page.destroyed.length === 0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// §5.3 Email page
// ─────────────────────────────────────────────────────────────────────────────

/** What the delta job must fetch for this page, after §5.3's filtering. */
export interface EmailFetchPlan {
  /** Full envelope tier (`EMAIL_LIST_PROPERTIES`). */
  createIds: string[];
  /** 3 properties only (`EMAIL_MUTABLE_PROPERTIES`). Never bodies. */
  updateIds: string[];
  destroyIds: string[];
}

/**
 * §5.3, including the case revision 2 got wrong twice.
 *
 * An `updated` id we do NOT hold locally is an UNCONDITIONAL NO-OP, and it is
 * filtered out BEFORE the fetch is issued — cheaper, and it removes revision 1's
 * F26 wording, which implied fabricating a `receivedAt` that a 3-property response
 * cannot supply and the schema's `NOT NULL` would reject.
 *
 * Safe to ignore because absence is always either "retention decided against it"
 * or "coverage hasn't reached it yet" — and coverage enumerates CURRENT state, so
 * it will pick the record up with the updated values anyway. Nothing needs the
 * update replayed.
 */
export function planEmailFetches(page: ChangesPage, presentIds: ReadonlySet<string>): EmailFetchPlan {
  const { created, updated, destroyed } = normalisePage(page);
  return {
    createIds: created,
    updateIds: updated.filter((id) => presentIds.has(id)),
    destroyIds: destroyed,
  };
}

export const EMAIL_UPDATE_PROPERTIES = EMAIL_MUTABLE_PROPERTIES;

/** What a page's application writes. Committed as one transaction, cursor last (I1). */
export interface EmailApplyPlan {
  upsertEnvelopes: EnvelopeRow[];
  patchMutable: Array<{
    key: RowKey;
    keywords: Record<string, boolean>;
    mailboxIds: Record<string, boolean>;
  }>;
  deleteEmails: RowKey[];
  enqueueBodies: BodyQueueEntry[];
  /** Ids the server omitted from `Email/get` — normal, not an error (F11). */
  skippedNotFound: string[];
}

export function emptyEmailApplyPlan(): EmailApplyPlan {
  return {
    upsertEnvelopes: [],
    patchMutable: [],
    deleteEmails: [],
    enqueueBodies: [],
    skippedNotFound: [],
  };
}

export function toEnvelopeRow(
  email: Email,
  jmapAccountId: JmapAccountId,
  now: number,
): EnvelopeRow {
  return {
    jmapAccountId,
    id: email.id,
    threadId: email.threadId ?? null,
    receivedAt: email.receivedAt,
    size: email.size ?? null,
    subject: email.subject ?? null,
    preview: email.preview ?? null,
    from: email.from ?? null,
    to: email.to ?? null,
    cc: email.cc ?? null,
    hasAttachment: Boolean(email.hasAttachment),
    keywords: email.keywords ?? {},
    mailboxIds: email.mailboxIds ?? {},
    // The body tier owns has_body/body_bytes; `upsertEnvelopes` never overwrites
    // them on an existing row, so a page replay cannot make job C2 re-download
    // every body in the page (I5).
    hasBody: false,
    bodyBytes: 0,
    cachedAt: now,
  };
}

export interface ApplyEmailPageInput {
  jmapAccountId: JmapAccountId;
  plan: EmailFetchPlan;
  /** Envelope-tier results for `plan.createIds`. */
  created: readonly Email[];
  /** 3-property results for `plan.updateIds`. */
  updated: readonly Email[];
  /** Ids `Email/get` omitted, from either call. */
  notFound: readonly string[];
  /** ISO floor of the BODY window; `null` disables body enqueueing entirely. */
  bodyFrom: string | null;
  /** Local intent, so no body is enqueued for a doomed message (F29). */
  pending?: PendingIndex;
  now: number;
}

export function applyEmailPage(input: ApplyEmailPageInput): EmailApplyPlan {
  const out = emptyEmailApplyPlan();
  const notFound = new Set(input.notFound);
  out.skippedNotFound = [...notFound];

  // CREATES first (§5.4).
  for (const email of input.created) {
    if (notFound.has(email.id)) continue;
    out.upsertEnvelopes.push(toEnvelopeRow(email, input.jmapAccountId, input.now));

    // Envelope tier only. Bodies are NEVER fetched inline: they are 10–500 KB
    // against an envelope's ~1 KB, and the queue is what keeps a page a small,
    // quickly-committable unit.
    const inBodyWindow = input.bodyFrom !== null && email.receivedAt >= input.bodyFrom;
    if (inBodyWindow && !hasPendingDestroy(input.pending?.get(email.id))) {
      out.enqueueBodies.push({
        jmapAccountId: input.jmapAccountId,
        emailId: email.id,
        receivedAt: email.receivedAt,
        attempts: 0,
      });
    }
  }

  // Then UPDATES. 3 properties, never bodies: `keywords` and `mailboxIds` are the
  // only mutable Email properties (RFC 8621 §4.1), so the existing body blob stays
  // valid. This is the largest efficiency difference from the old sync and what
  // closes D1 (a message cached while unread staying unread forever).
  for (const email of input.updated) {
    if (notFound.has(email.id)) continue;
    out.patchMutable.push({
      key: { jmapAccountId: input.jmapAccountId, id: email.id },
      keywords: email.keywords ?? {},
      mailboxIds: email.mailboxIds ?? {},
    });
  }

  // DESTROYS last. A destroy for an id we never held is a harmless no-op and the
  // page still counts as applied (F27).
  for (const id of input.plan.destroyIds) {
    out.deleteEmails.push({ jmapAccountId: input.jmapAccountId, id });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5.2 Mailbox page
// ─────────────────────────────────────────────────────────────────────────────

const COUNT_PROPERTIES = new Set([
  'totalEmails',
  'unreadEmails',
  'totalThreads',
  'unreadThreads',
]);

/**
 * RFC 8621 §2.2's optimisation: *"If only the totalEmails, unreadEmails,
 * totalThreads, and/or unreadThreads Mailbox properties have changed since the old
 * state, this will be the list of properties that may have changed"*, and *"If the
 * server is unable to tell whether only counts have changed, it MUST just be
 * null."*
 *
 * Counts change on every delivery and every read, so on a busy account this is the
 * difference between patching four integers and re-fetching every folder object.
 * "May have changed" makes the list an upper bound, so patching exactly those
 * columns is correct.
 */
export function updatedPropertiesAreCountsOnly(
  updatedProperties: readonly string[] | null | undefined,
): boolean {
  if (!updatedProperties) return false;
  if (updatedProperties.length === 0) return true;
  return updatedProperties.every((p) => COUNT_PROPERTIES.has(p));
}

export interface MailboxFetchPlan {
  /** Need a full `Mailbox/get` object. */
  fullIds: string[];
  /** Need only the four count columns. */
  countIds: string[];
  destroyIds: string[];
  countProperties: string[];
}

export function planMailboxFetches(
  page: ChangesPage,
  updatedProperties: readonly string[] | null | undefined,
): MailboxFetchPlan {
  const { created, updated, destroyed } = normalisePage(page);
  const countsOnly = updatedPropertiesAreCountsOnly(updatedProperties);
  return {
    // A `created` mailbox always needs the full object.
    fullIds: countsOnly ? created : [...created, ...updated],
    countIds: countsOnly ? updated : [],
    destroyIds: destroyed,
    countProperties: ['id', ...COUNT_PROPERTIES],
  };
}

export interface MailboxApplyPlan {
  upsertMailboxes: MailboxRow[];
  patchCounts: Array<{ key: RowKey; counts: Partial<MailboxCounts> }>;
  deleteMailboxes: RowKey[];
}

export function emptyMailboxApplyPlan(): MailboxApplyPlan {
  return { upsertMailboxes: [], patchCounts: [], deleteMailboxes: [] };
}

export function toMailboxRow(mailbox: Mailbox, jmapAccountId: JmapAccountId): MailboxRow {
  return {
    jmapAccountId,
    // The RAW JMAP id. The display layer's `<accountId>:<id>` prefix for shared
    // folders (email.ts:19-20) must not reach the store: the store keys every row
    // by `(jmapAccountId, id)` itself (S3), so a prefixed id would double-encode
    // the account and break every lookup.
    id: mailbox.originalId ?? mailbox.id,
    name: mailbox.name,
    parentId: mailbox.parentId ?? null,
    role: mailbox.role ?? null,
    sortOrder: mailbox.sortOrder ?? null,
    totalEmails: mailbox.totalEmails ?? null,
    unreadEmails: mailbox.unreadEmails ?? null,
    totalThreads: mailbox.totalThreads ?? null,
    unreadThreads: mailbox.unreadThreads ?? null,
    myRights: mailbox.myRights ?? null,
    isSubscribed: mailbox.isSubscribed ?? true,
  };
}

export function applyMailboxPage(input: {
  jmapAccountId: JmapAccountId;
  plan: MailboxFetchPlan;
  full: readonly Mailbox[];
  counts: readonly Mailbox[];
}): MailboxApplyPlan {
  const out = emptyMailboxApplyPlan();

  for (const mailbox of input.full) {
    out.upsertMailboxes.push(toMailboxRow(mailbox, input.jmapAccountId));
  }

  for (const mailbox of input.counts) {
    out.patchCounts.push({
      key: { jmapAccountId: input.jmapAccountId, id: mailbox.originalId ?? mailbox.id },
      counts: {
        totalEmails: mailbox.totalEmails ?? null,
        unreadEmails: mailbox.unreadEmails ?? null,
        totalThreads: mailbox.totalThreads ?? null,
        unreadThreads: mailbox.unreadThreads ?? null,
      },
    });
  }

  // §5.2 / I7: delete the mailbox row ONLY. Never touch email records. If the
  // server destroyed the messages too (`onDestroyRemoveEmails`), `Email/changes`
  // reports them `destroyed`; if it moved them, their `mailboxIds` update arrives
  // as `updated`. Truth arrives on the Email stream either way (F7).
  for (const id of input.plan.destroyIds) {
    out.deleteMailboxes.push({ jmapAccountId: input.jmapAccountId, id });
  }

  return out;
}
