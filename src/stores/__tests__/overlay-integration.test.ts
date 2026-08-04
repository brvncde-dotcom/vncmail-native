// Stage D step 2: the §5.6 overlay wired into email-store's three read paths.
//
// These go through the real store actions rather than calling `applyPendingOps` directly —
// the pure overlay already has unit coverage, and what was untested is the WIRING: whether
// a queued mutation is actually visible on each of the paths that feed the UI.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheEntries = new Map<string, unknown>();
let cacheList: unknown[] = [];

// `refreshEmails` bails unless the client is actually serving the active account (the
// account-switch guard), so the client has to look connected for that path to run at all.
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    isConnected: true,
    username: 'alice',
    serverUrl: 'https://mail.example',
    accountId: 'jmap-A',
    getAccountName: () => 'Alice',
    getMaxObjectsInGet: () => 500,
    getMaxCallsInRequest: () => 16,
  },
}));

vi.mock('../../api/email', () => ({
  getMailboxes: vi.fn(async () => []),
  getMailboxesWithState: vi.fn(async () => ({ list: [], state: 'mb-0' })),
  getSharedMailboxes: vi.fn(async () => []),
  getMailboxesByIds: vi.fn(async () => ({ list: [], state: 'mb-0' })),
  getMailboxChanges: vi.fn(async () => null),
  queryEmails: vi.fn(async () => {
    throw new Error('Network request failed');
  }),
  getEmailQueryChanges: vi.fn(async () => null),
  getEmails: vi.fn(async () => []),
  getEmailsWithState: vi.fn(async () => ({ list: [], state: 'em-0' })),
  getEmailChanges: vi.fn(async () => null),
  // Offline: the network read always fails, so the cached fallback is what runs.
  getFullEmail: vi.fn(async () => {
    throw new Error('Network request failed');
  }),
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

vi.mock('../offline-cache-store', () => ({
  useOfflineCacheStore: {
    getState: () => ({
      hydrated: true,
      hydrate: vi.fn(async () => undefined),
      totalCount: () => cacheList.length,
      getEmailsInMailbox: vi.fn(async () => cacheList),
      get: vi.fn(async (id: string) => cacheEntries.get(id) ?? null),
      has: () => false,
      put: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      setAccount: vi.fn(async () => undefined),
    }),
  },
}));

// A real-enough outbox: `enqueue` records the op, and `pendingOpsForOverlay` reports it.
// The overlay's whole premise is that this queue is the durable record of intent, so a
// fake that forgets the op would test nothing.
const queue: Array<{ kind: string; emailId: string; keywords?: unknown; mailboxIds?: unknown }> = [];

vi.mock('../outbox-store', () => ({
  applyOrQueueBatch: async (ops: typeof queue) => {
    queue.push(...ops);
    return { queued: true };
  },
  applyOrQueue: async (op: (typeof queue)[number]) => {
    queue.push(op);
    return { queued: true };
  },
  pendingOpsForOverlay: () => [...queue],
  useOutboxStore: {
    getState: () => ({
      entries: queue.map((op) => ({ id: op.emailId, op })),
      count: () => queue.length,
      pendingForEmail: (id: string) => queue.filter((o) => o.emailId === id),
      setAccount: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
    }),
  },
}));

import { useEmailStore } from '../email-store';

const INBOX = {
  id: 'inbox',
  name: 'Inbox',
  role: 'inbox',
  totalEmails: 2,
  unreadEmails: 2,
  totalThreads: 2,
  unreadThreads: 2,
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queue.length = 0;
  cacheEntries.clear();
  cacheList = [];
  useEmailStore.setState({
    activeAccountId: 'alice@mail.example',
    mailboxes: [INBOX],
    currentMailboxId: 'inbox',
    emails: [],
    notice: null,
    mailboxSnapshots: {},
  });
});

describe('§12.3 item 3: getEmailDetail\'s cached read applies the overlay', () => {
  it('shows a message as read offline after it was marked read offline', async () => {
    // The design calls this "the most visible possible instance of the bug the overlay
    // exists to prevent". The durable copy still says unread — the outbox has not
    // flushed — and the overlay is the only thing that makes the UI agree with what the
    // user just did.
    cacheEntries.set('E1', email('E1', {}));
    useEmailStore.setState({ emails: [email('E1') as never] });

    await useEmailStore.getState().markRead('E1');
    expect(queue).toHaveLength(1);

    const detail = await useEmailStore.getState().getEmailDetail('E1');
    expect(detail.keywords).toEqual({ $seen: true });
  });

  it('applies a pending star to the cached read', async () => {
    cacheEntries.set('E1', email('E1', {}));
    useEmailStore.setState({ emails: [email('E1') as never] });

    await useEmailStore.getState().toggleStar('E1', true);
    const detail = await useEmailStore.getState().getEmailDetail('E1');
    expect(detail.keywords.$flagged).toBe(true);
  });

  it('a queued destroy hides the message instead of serving a stale copy', async () => {
    cacheEntries.set('E1', email('E1'));
    queue.push({ kind: 'destroy', emailId: 'E1' });
    // The record is NOT deleted from the store (I7: deletion provenance), it is just
    // hidden from reads — so the honest answer for a message on its way out is the
    // original network error, not a copy the user already told us to delete.
    await expect(useEmailStore.getState().getEmailDetail('E1')).rejects.toThrow(
      /Network request failed/,
    );
  });

  it('leaves an unaffected message alone', async () => {
    cacheEntries.set('E2', email('E2', { $seen: true }));
    queue.push({ kind: 'keywords', emailId: 'E1', keywords: { $flagged: true } });
    const detail = await useEmailStore.getState().getEmailDetail('E2');
    expect(detail.keywords).toEqual({ $seen: true });
  });
});

describe('§12.3 items 1-2: the list read paths apply the overlay', () => {
  it('selectMailbox\'s cache seed reflects a pending keyword change', async () => {
    cacheList = [email('E1', {}), email('E2', {})];
    queue.push({ kind: 'keywords', emailId: 'E1', keywords: { $seen: true } });

    await useEmailStore.getState().selectMailbox('inbox');

    const seeded = useEmailStore.getState().emails;
    expect(seeded.map((e) => e.id)).toEqual(['E1', 'E2']);
    expect(seeded.find((e) => e.id === 'E1')?.keywords).toEqual({ $seen: true });
    expect(seeded.find((e) => e.id === 'E2')?.keywords).toEqual({});
  });

  it('selectMailbox\'s cache seed hides a pending destroy, shortening the page', async () => {
    cacheList = [email('E1'), email('E2')];
    queue.push({ kind: 'destroy', emailId: 'E1' });

    await useEmailStore.getState().selectMailbox('inbox');
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['E2']);
    // The count follows the rendered rows, not the raw cache.
    expect(useEmailStore.getState().totalEmails).toBe(1);
  });

  it('refreshEmails\' offline fallback reflects a pending move out of the folder', async () => {
    cacheList = [email('E1'), email('E2')];
    queue.push({ kind: 'mailboxes', emailId: 'E1', mailboxIds: { archive: true } });

    useEmailStore.setState({ emails: [], currentMailboxId: 'inbox' });
    await useEmailStore.getState().refreshEmails();

    const rows = useEmailStore.getState().emails;
    // The row is still present (the overlay does not filter by folder) but its membership
    // reflects the user's intent, which is what the folder UI resolves against.
    expect(rows.find((e) => e.id === 'E1')?.mailboxIds).toEqual({ archive: true });
  });
});
