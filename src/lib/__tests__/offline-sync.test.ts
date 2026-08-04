import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email } from '../../api/types';

const client = { accountId: 'acc-1' };

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    get accountId() {
      return client.accountId;
    },
    getMaxObjectsInGet: () => 25,
  },
}));

vi.mock('../../api/email', () => ({
  queryEmailsByFilter: vi.fn(),
  getFullEmails: vi.fn(),
  getEmails: vi.fn(),
}));

import { queryEmailsByFilter, getFullEmails, getEmails } from '../../api/email';
import { useOfflineCacheStore } from '../../stores/offline-cache-store';
import { runOfflineSync } from '../offline-sync';

const mockQuery = queryEmailsByFilter as ReturnType<typeof vi.fn>;
const mockGetFull = getFullEmails as ReturnType<typeof vi.fn>;
const mockGetEmails = getEmails as ReturnType<typeof vi.fn>;

function makeEmail(overrides: Partial<Email> & { id: string }): Email {
  return {
    threadId: `t-${overrides.id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    size: 100,
    receivedAt: '2026-01-01T00:00:00Z',
    hasAttachment: false,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  client.accountId = 'acc-1';
  await useOfflineCacheStore.getState().setAccount('acc-1');
  await useOfflineCacheStore.getState().clearAll();
  useOfflineCacheStore.setState({
    abortRequested: false,
    sync: { phase: 'idle', total: 0, completed: 0, fetched: 0, bytes: 0 },
  });
});

describe('runOfflineSync', () => {
  it('refreshes keywords/mailboxIds for already-cached ids instead of leaving them stale (D1)', async () => {
    await useOfflineCacheStore.getState().put(
      makeEmail({ id: 'e1', keywords: {}, mailboxIds: { inbox: true } }),
      100,
    );

    mockQuery.mockResolvedValue(['e1']);
    mockGetEmails.mockResolvedValue([
      makeEmail({ id: 'e1', keywords: { $seen: true }, mailboxIds: { inbox: true } }),
    ]);

    await runOfflineSync({ days: 30 });

    expect(mockGetEmails).toHaveBeenCalledWith(['e1'], 'acc-1');
    expect(mockGetFull).not.toHaveBeenCalled();

    const patched = await useOfflineCacheStore.getState().get('e1');
    expect(patched?.keywords).toEqual({ $seen: true });
    expect(useOfflineCacheStore.getState().sync.phase).toBe('done');
  });

  it('still fetches full bodies for ids not already cached', async () => {
    mockQuery.mockResolvedValue(['e2']);
    mockGetFull.mockResolvedValue([makeEmail({ id: 'e2' })]);

    await runOfflineSync({ days: 30 });

    expect(mockGetFull).toHaveBeenCalledWith(['e2'], 'acc-1');
    expect(mockGetEmails).not.toHaveBeenCalled();
    expect(useOfflineCacheStore.getState().has('e2')).toBe(true);
    expect(useOfflineCacheStore.getState().sync.phase).toBe('done');
  });

  it('cancels instead of fetching under a different account after a mid-run account switch (D6)', async () => {
    mockQuery.mockImplementation(async () => {
      // Simulate the user switching accounts while discovery is in flight.
      client.accountId = 'acc-2';
      await useOfflineCacheStore.getState().setAccount('acc-2');
      return ['e1'];
    });

    await runOfflineSync({ days: 30 });

    expect(mockGetFull).not.toHaveBeenCalled();
    expect(mockGetEmails).not.toHaveBeenCalled();
    expect(useOfflineCacheStore.getState().sync.phase).toBe('cancelled');
  });

  it('does not cancel an in-flight sync when triggered again (D7)', async () => {
    useOfflineCacheStore.setState({
      sync: { phase: 'fetching', total: 10, completed: 3, fetched: 3, bytes: 100 },
    });

    await runOfflineSync({ days: 30 });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(useOfflineCacheStore.getState().sync).toEqual({
      phase: 'fetching',
      total: 10,
      completed: 3,
      fetched: 3,
      bytes: 100,
    });
  });
});
