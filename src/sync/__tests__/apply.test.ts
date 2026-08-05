// §5.2–§5.4 as pure data, which is exactly what §2.2 made `apply.ts` pure for:
// these rows of §11's failure table become assertions rather than promises.

import { describe, expect, it } from 'vitest';

import {
  applyEmailPage,
  applyMailboxPage,
  type ChangesPage,
  normalisePage,
  pageIsEmpty,
  planEmailFetches,
  planMailboxFetches,
  updatedPropertiesAreCountsOnly,
} from '../apply';
import { indexPendingOps } from '../overlay';
import { asChangesState } from '../states';

const JA = 'jmap-acct-1';
const NOW = 1_770_000_000_000;

function page(over: Partial<ChangesPage> = {}): ChangesPage {
  return {
    oldState: asChangesState('s1'),
    newState: asChangesState('s2'),
    hasMoreChanges: false,
    created: [],
    updated: [],
    destroyed: [],
    ...over,
  };
}

function email(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    threadId: `T-${id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    size: 100,
    receivedAt: '2026-08-01T12:00:00Z',
    hasAttachment: false,
    ...over,
  } as never;
}

describe('§5.4 ordering and overlap within one page', () => {
  it('applies creates, then updates, then destroys', () => {
    const p = page({ created: ['A'], updated: ['B'], destroyed: ['C'] });
    expect(normalisePage(p)).toEqual({
      created: ['A'],
      updated: ['B'],
      destroyed: ['C'],
    });
  });

  it('destroy wins over create and update for the same id', () => {
    // RFC 8620 §5.2 permits the overlap. Because ids are never reused (§1.2), a
    // destroy always refers to the same record, so destroy-last converges. The
    // reverse order would resurrect a dead id, spend a fetch and get notFound.
    const p = page({ created: ['A', 'B'], updated: ['A', 'C'], destroyed: ['A'] });
    const n = normalisePage(p);
    expect(n.destroyed).toEqual(['A']);
    expect(n.created).toEqual(['B']);
    expect(n.updated).toEqual(['C']);
    expect(n.created).not.toContain('A');
    expect(n.updated).not.toContain('A');
  });

  it('an id in both created and updated is treated as a create', () => {
    // The create path fetches the full envelope tier, which already carries the
    // updated values — so a second 3-property fetch would be pure waste.
    const n = normalisePage(page({ created: ['A'], updated: ['A'] }));
    expect(n.created).toEqual(['A']);
    expect(n.updated).toEqual([]);
  });

  it('deduplicates repeated ids', () => {
    const n = normalisePage(page({ created: ['A', 'A'], destroyed: ['B', 'B'] }));
    expect(n.created).toEqual(['A']);
    expect(n.destroyed).toEqual(['B']);
  });

  it('recognises an empty page, which still advances the cursor (§7.5 rule 4)', () => {
    expect(pageIsEmpty(page())).toBe(true);
    expect(pageIsEmpty(page({ updated: ['A'] }))).toBe(false);
  });
});

describe('§5.3 Email fetch planning', () => {
  it('filters absent updated ids out BEFORE the fetch (F26/S16)', () => {
    const plan = planEmailFetches(
      page({ created: ['NEW'], updated: ['HAVE', 'MISSING'] }),
      new Set(['HAVE']),
    );
    expect(plan.createIds).toEqual(['NEW']);
    // MISSING never reaches the network. Absence means retention decided against it
    // or coverage hasn't reached it — and coverage enumerates CURRENT state, so it
    // will pick the record up with the updated values anyway.
    expect(plan.updateIds).toEqual(['HAVE']);
  });

  it('does not require presence for creates', () => {
    const plan = planEmailFetches(page({ created: ['NEW'] }), new Set());
    expect(plan.createIds).toEqual(['NEW']);
  });
});

describe('§5.3 Email page application', () => {
  it('writes envelopes for creates and enqueues bodies inside the body window', () => {
    const plan = planEmailFetches(page({ created: ['A'] }), new Set());
    const applied = applyEmailPage({
      jmapAccountId: JA,
      plan,
      created: [email('A', { receivedAt: '2026-08-01T12:00:00Z' })],
      updated: [],
      notFound: [],
      bodyFrom: '2026-07-01T00:00:00Z',
      now: NOW,
    });
    expect(applied.upsertEnvelopes).toHaveLength(1);
    expect(applied.upsertEnvelopes[0]).toMatchObject({
      jmapAccountId: JA,
      id: 'A',
      // The body tier owns these; upsertEnvelopes must not claim them (I5).
      hasBody: false,
      bodyBytes: 0,
      cachedAt: NOW,
    });
    expect(applied.enqueueBodies).toEqual([
      { jmapAccountId: JA, emailId: 'A', receivedAt: '2026-08-01T12:00:00Z', attempts: 0 },
    ]);
  });

  it('does not enqueue a body outside the body window (§2.1 two tiers)', () => {
    const plan = planEmailFetches(page({ created: ['OLD'] }), new Set());
    const applied = applyEmailPage({
      jmapAccountId: JA,
      plan,
      created: [email('OLD', { receivedAt: '2026-01-01T00:00:00Z' })],
      updated: [],
      notFound: [],
      bodyFrom: '2026-07-01T00:00:00Z',
      now: NOW,
    });
    // Envelope kept (it is inside the wider envelope window), body not fetched.
    expect(applied.upsertEnvelopes).toHaveLength(1);
    expect(applied.enqueueBodies).toEqual([]);
  });

  it('never enqueues a body for a message with a pending destroy (F29)', () => {
    const plan = planEmailFetches(page({ created: ['A'] }), new Set());
    const applied = applyEmailPage({
      jmapAccountId: JA,
      plan,
      created: [email('A')],
      updated: [],
      notFound: [],
      bodyFrom: '2026-07-01T00:00:00Z',
      pending: indexPendingOps([{ kind: 'destroy', emailId: 'A' }]),
      now: NOW,
    });
    expect(applied.upsertEnvelopes).toHaveLength(1);
    expect(applied.enqueueBodies).toEqual([]);
  });

  it('an updated email costs a keywords/mailboxIds patch and NEVER a body (D1)', () => {
    const plan = planEmailFetches(page({ updated: ['A'] }), new Set(['A']));
    const applied = applyEmailPage({
      jmapAccountId: JA,
      plan,
      created: [],
      updated: [email('A', { keywords: { $seen: true }, mailboxIds: { archive: true } })],
      notFound: [],
      bodyFrom: '2026-07-01T00:00:00Z',
      now: NOW,
    });
    expect(applied.patchMutable).toEqual([
      {
        key: { jmapAccountId: JA, id: 'A' },
        keywords: { $seen: true },
        mailboxIds: { archive: true },
      },
    ]);
    // The whole point: no envelope rewrite, no body enqueue, no body fetch.
    expect(applied.upsertEnvelopes).toEqual([]);
    expect(applied.enqueueBodies).toEqual([]);
  });

  it('skips ids the server omitted from Email/get (F11)', () => {
    const plan = planEmailFetches(page({ created: ['A', 'GONE'] }), new Set());
    const applied = applyEmailPage({
      jmapAccountId: JA,
      plan,
      created: [email('A')],
      updated: [],
      notFound: ['GONE'],
      bodyFrom: null,
      now: NOW,
    });
    expect(applied.upsertEnvelopes.map((e) => e.id)).toEqual(['A']);
    expect(applied.skippedNotFound).toEqual(['GONE']);
  });

  it('a destroy for an id we never held is a harmless no-op (F27)', () => {
    const plan = planEmailFetches(page({ destroyed: ['NEVER-HELD'] }), new Set());
    const applied = applyEmailPage({
      jmapAccountId: JA,
      plan,
      created: [],
      updated: [],
      notFound: [],
      bodyFrom: null,
      now: NOW,
    });
    // The plan still emits the delete; the store's delete-if-exists makes it a
    // no-op, and the page still counts as applied so the cursor advances.
    expect(applied.deleteEmails).toEqual([{ jmapAccountId: JA, id: 'NEVER-HELD' }]);
  });

  it('bodyFrom null disables body enqueueing entirely', () => {
    const plan = planEmailFetches(page({ created: ['A'] }), new Set());
    const applied = applyEmailPage({
      jmapAccountId: JA,
      plan,
      created: [email('A')],
      updated: [],
      notFound: [],
      bodyFrom: null,
      now: NOW,
    });
    expect(applied.enqueueBodies).toEqual([]);
  });
});

describe('§5.2 Mailbox page application', () => {
  it('recognises a counts-only updatedProperties (RFC 8621 §2.2)', () => {
    expect(updatedPropertiesAreCountsOnly(['unreadEmails'])).toBe(true);
    expect(updatedPropertiesAreCountsOnly(['totalEmails', 'unreadThreads'])).toBe(true);
    expect(updatedPropertiesAreCountsOnly([])).toBe(true);
    expect(updatedPropertiesAreCountsOnly(['name'])).toBe(false);
    // "If the server is unable to tell whether only counts have changed, it MUST
    // just be null" — which means a FULL refetch, not a counts patch.
    expect(updatedPropertiesAreCountsOnly(null)).toBe(false);
    expect(updatedPropertiesAreCountsOnly(undefined)).toBe(false);
  });

  it('patches only counts when updatedProperties says so', () => {
    const plan = planMailboxFetches(page({ updated: ['inbox'] }), ['unreadEmails']);
    expect(plan.countIds).toEqual(['inbox']);
    expect(plan.fullIds).toEqual([]);
  });

  it('refetches the full object when updatedProperties is null', () => {
    const plan = planMailboxFetches(page({ updated: ['inbox'] }), null);
    expect(plan.fullIds).toEqual(['inbox']);
    expect(plan.countIds).toEqual([]);
  });

  it('always refetches a created mailbox in full, even alongside a counts hint', () => {
    const plan = planMailboxFetches(
      page({ created: ['new'], updated: ['inbox'] }),
      ['unreadEmails'],
    );
    expect(plan.fullIds).toEqual(['new']);
    expect(plan.countIds).toEqual(['inbox']);
  });

  it('destroying a mailbox deletes the mailbox row ONLY (I7/F7)', () => {
    const plan = planMailboxFetches(page({ destroyed: ['old'] }), null);
    const applied = applyMailboxPage({
      jmapAccountId: JA,
      plan,
      full: [],
      counts: [],
    });
    expect(applied.deleteMailboxes).toEqual([{ jmapAccountId: JA, id: 'old' }]);
    // There is deliberately no field on MailboxApplyPlan that could delete an
    // email — the type makes I7 unexpressible here.
    expect(Object.keys(applied).sort()).toEqual([
      'deleteMailboxes',
      'patchCounts',
      'upsertMailboxes',
    ]);
  });

  it('uses the RAW jmap id, not the shared-account display prefix (S3)', () => {
    const plan = planMailboxFetches(page({ created: ['acct-2:inbox'] }), null);
    const applied = applyMailboxPage({
      jmapAccountId: JA,
      plan,
      full: [
        {
          id: 'acct-2:inbox',
          originalId: 'inbox',
          name: 'Inbox',
          totalEmails: 1,
          unreadEmails: 1,
          totalThreads: 1,
          unreadThreads: 1,
        } as never,
      ],
      counts: [],
    });
    // The display layer's `<accountId>:<id>` prefix must not reach the store: the
    // store keys rows by (jmapAccountId, id) itself, so a prefixed id would
    // double-encode the account and break every lookup.
    expect(applied.upsertMailboxes[0].id).toBe('inbox');
  });
});
