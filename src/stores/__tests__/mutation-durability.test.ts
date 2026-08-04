// Stage D steps 0 and 1: local mutations must go through the outbox, and a failure to
// record one must be visible to the user.
//
// Both of these were found by the code review and both are premises the §5.6 overlay
// rests on: the outbox is the SOLE durable record of local intent, so a mutation that
// bypasses it has no durable record at all, and a mutation whose write fails silently is
// indistinguishable from one that succeeded.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/email', () => ({
  getMailboxes: vi.fn(async () => []),
  getMailboxesWithState: vi.fn(async () => ({ list: [], state: 'mb-0' })),
  getSharedMailboxes: vi.fn(async () => []),
  getMailboxesByIds: vi.fn(async () => ({ list: [], state: 'mb-0' })),
  getMailboxChanges: vi.fn(async () => null),
  queryEmails: vi.fn(async () => ({ ids: [], total: 0 })),
  getEmailQueryChanges: vi.fn(async () => null),
  getEmails: vi.fn(async () => []),
  getEmailsWithState: vi.fn(async () => ({ list: [], state: 'em-0' })),
  getEmailChanges: vi.fn(async () => null),
  getFullEmail: vi.fn(),
  setEmailKeywords: vi.fn(async () => undefined),
  setKeywordsForEmails: vi.fn(async () => undefined),
  moveEmail: vi.fn(async () => undefined),
  moveEmails: vi.fn(async () => undefined),
  archiveEmails: vi.fn(async () => undefined),
  restoreEmailMailboxes: vi.fn(async () => undefined),
  setEmailMailboxes: vi.fn(async () => undefined),
  destroyEmails: vi.fn(async () => undefined),
  deleteEmail: vi.fn(async () => undefined),
  deleteEmails: vi.fn(async () => undefined),
  searchEmails: vi.fn(async () => []),
  unprefixMailboxId: (id: string) => id,
}));

// The outbox is made to FAIL, which is the whole point: the store must not report or
// render success for a mutation it could not record.
const enqueued: unknown[] = [];
let outboxFails = false;

vi.mock('../outbox-store', () => {
  const applyOrQueueBatch = async (ops: unknown[]) => {
    if (outboxFails) throw new Error('disk full');
    enqueued.push(...ops);
    return { queued: true };
  };
  return {
    applyOrQueueBatch,
    applyOrQueue: async (op: unknown) => applyOrQueueBatch([op]),
    useOutboxStore: {
      getState: () => ({
        entries: [],
        count: () => 0,
        pendingForEmail: () => [],
        setAccount: vi.fn(async () => undefined),
        flush: vi.fn(async () => undefined),
      }),
    },
  };
});

import { setEmailKeywords } from '../../api/email';
import { useEmailStore } from '../email-store';

const INBOX = {
  id: 'inbox',
  name: 'Inbox',
  role: 'inbox',
  totalEmails: 1,
  unreadEmails: 1,
  totalThreads: 1,
  unreadThreads: 1,
} as never;

function email(id: string, keywords: Record<string, boolean> = {}) {
  return {
    id,
    threadId: `T-${id}`,
    mailboxIds: { inbox: true },
    keywords,
    size: 10,
    receivedAt: '2026-08-01T00:00:00Z',
    hasAttachment: false,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  enqueued.length = 0;
  outboxFails = false;
  useEmailStore.setState({
    mailboxes: [INBOX],
    currentMailboxId: 'inbox',
    emails: [email('E1')],
    notice: null,
  });
});

describe('step 0: no mutation path bypasses the outbox', () => {
  it('EmailThreadScreen does not call setEmailKeywords directly', () => {
    // A grep, because rendering the screen needs the whole RN tree. Crude, but it is the
    // property that matters and it fails loudly if someone reintroduces the bypass.
    //
    // The bypass mattered specifically because §5.6 removed the optimistic write-through
    // into the durable store: with the overlay as the only mechanism, a mutation that
    // never reaches the outbox has NO durable record, so it is lost on the next launch
    // and the overlay cannot show it in the meantime either.
    const src = readFileSync(
      join(__dirname, '..', '..', 'screens', 'EmailThreadScreen.tsx'),
      'utf8',
    );
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line: line.replace(/\/\/.*$/, ''), n: i + 1 }))
      .filter(({ line }) => /\bsetEmailKeywords\s*\(/.test(line));
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
  });

  it('records a keyword change for a message that is NOT in the visible list', async () => {
    // This is why the screen bypassed the store in the first place: every existing
    // mutation bails with `if (!email) return`, and a thread pane holds messages that are
    // not in `state.emails`.
    await useEmailStore.getState().setKeywordsFor('NOT-IN-LIST', { $flagged: true });
    expect(enqueued).toEqual([
      { kind: 'keywords', emailId: 'NOT-IN-LIST', accountId: undefined, keywords: { $flagged: true } },
    ]);
    expect(setEmailKeywords).not.toHaveBeenCalled();
  });

  it('updates the visible row too when the message IS in the list', async () => {
    await useEmailStore.getState().setKeywordsFor('E1', { $seen: true });
    expect(useEmailStore.getState().emails[0].keywords).toEqual({ $seen: true });
  });
});

describe('step 1: a failed local mutation is visible', () => {
  it('surfaces a notice and does NOT apply the optimistic update', async () => {
    outboxFails = true;
    await useEmailStore.getState().markRead('E1');

    // Before this, a write failure moved from "phantom success, mutation lost silently"
    // to "unhandled rejection, mutation lost silently" — no user-visible improvement.
    const notice = useEmailStore.getState().notice;
    expect(notice).not.toBeNull();
    expect(notice?.label.toLowerCase()).toMatch(/couldn[\u2019']t|failed|not saved/);

    // And the row must NOT look changed, or the UI would show a state that exists
    // nowhere — the exact failure the outbox durability fix was for.
    expect(useEmailStore.getState().emails[0].keywords).toEqual({});
  });

  it('does not reject into the caller, so `void store.markRead(...)` is safe', async () => {
    outboxFails = true;
    // ~15 UI call sites invoke these with `void` and no handler. The store owns the
    // optimistic update, so the store owns the rollback and the notice; making callers
    // responsible would mean touching every one of them and still missing the next.
    await expect(useEmailStore.getState().markRead('E1')).resolves.toBeUndefined();
    await expect(useEmailStore.getState().toggleStar('E1', true)).resolves.toBeUndefined();
    await expect(useEmailStore.getState().setKeywordsFor('E1', {})).resolves.toBeUndefined();
  });

  it('surfaces a notice for a failed star and leaves the row alone', async () => {
    outboxFails = true;
    await useEmailStore.getState().toggleStar('E1', true);
    expect(useEmailStore.getState().notice).not.toBeNull();
    expect(useEmailStore.getState().emails[0].keywords).toEqual({});
  });

  it('clears the notice on demand', async () => {
    outboxFails = true;
    await useEmailStore.getState().markRead('E1');
    expect(useEmailStore.getState().notice).not.toBeNull();
    useEmailStore.getState().clearNotice();
    expect(useEmailStore.getState().notice).toBeNull();
  });

  it('a successful mutation leaves no notice behind', async () => {
    await useEmailStore.getState().markRead('E1');
    expect(useEmailStore.getState().notice).toBeNull();
    expect(useEmailStore.getState().emails[0].keywords).toEqual({ $seen: true });
  });
});
