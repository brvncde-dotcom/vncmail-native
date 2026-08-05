// The outbox durability requirement of design §5.6.1 (revision 3's V1 finding).
//
// Why this matters more than it looks: §5.6 removes the optimistic write-through
// into the durable record store and replaces it with a read-time overlay. That
// promotes this queue from a belt-and-braces retry buffer to the SOLE durable
// record of a local mutation. Revision 2 asserted the outbox "already persists
// before the UI reports success"; it did not — `persist()` was
// `void AsyncStorage.setItem(...).catch(warn)` and `enqueue` returned before the
// write landed, so `applyOrQueueBatch` reported `{ queued: true }` with nothing on
// disk. A kill in that window lost the mutation with no second copy to recover it
// from.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: () => () => undefined,
    fetch: async () => ({ isConnected: true, isInternetReachable: true }),
  },
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { isConnected: true },
}));

vi.mock('../../api/email', () => ({
  setEmailKeywords: vi.fn(async () => undefined),
  setEmailMailboxes: vi.fn(async () => undefined),
  destroyEmails: vi.fn(async () => undefined),
}));

// A storage double we can make fail, and whose writes we can hold open so the
// "reported success before the write landed" ordering bug is observable.
const memory = new Map<string, string>();
let failNextWrite = false;
let holdWrite: (() => void) | null = null;
const writesStarted: string[] = [];
const writesFinished: string[] = [];

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => memory.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      writesStarted.push(k);
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('disk full');
      }
      if (holdWrite) {
        await new Promise<void>((resolve) => {
          const release = holdWrite!;
          holdWrite = null;
          // The test releases us by calling the captured resolver.
          releaseHooks.push(() => {
            resolve();
          });
          release();
        });
      }
      memory.set(k, v);
      writesFinished.push(k);
    }),
    removeItem: vi.fn(async (k: string) => {
      memory.delete(k);
    }),
    clear: vi.fn(async () => memory.clear()),
    getAllKeys: vi.fn(async () => [...memory.keys()]),
    multiGet: vi.fn(async (keys: string[]) => keys.map((k) => [k, memory.get(k) ?? null])),
    multiSet: vi.fn(async () => undefined),
    multiRemove: vi.fn(async () => undefined),
  },
}));

const releaseHooks: Array<() => void> = [];

import { applyOrQueue, useOutboxStore } from '../outbox-store';
import { useNetworkStore } from '../network-store';

const ACCOUNT = 'alice@mail.example';

beforeEach(async () => {
  vi.clearAllMocks();
  memory.clear();
  writesStarted.length = 0;
  writesFinished.length = 0;
  releaseHooks.length = 0;
  failNextWrite = false;
  holdWrite = null;
  useNetworkStore.setState({ online: true, connected: true });
  await useOutboxStore.getState().setAccount(null);
  await useOutboxStore.getState().setAccount(ACCOUNT);
  useOutboxStore.setState({ entries: [] });
});

describe('outbox durability (§5.6.1, V1)', () => {
  it('enqueue rejects when the underlying write rejects', async () => {
    failNextWrite = true;
    await expect(
      useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } }),
    ).rejects.toThrow('disk full');
  });

  it('rolls the in-memory queue back when the write fails', async () => {
    // Otherwise the queue would claim an op it never persisted — which reads as
    // "saved" to every caller of pendingForEmail, including the overlay.
    failNextWrite = true;
    await expect(
      useOutboxStore.getState().enqueue({ kind: 'destroy', emailId: 'e1' }),
    ).rejects.toThrow('disk full');
    expect(useOutboxStore.getState().entries).toEqual([]);
    expect(useOutboxStore.getState().count()).toBe(0);
  });

  it('applyOrQueue raises to the caller instead of reporting a phantom success', async () => {
    // Offline, so it must queue rather than run.
    useNetworkStore.setState({ online: false, connected: false });
    failNextWrite = true;

    // The UI can now surface "couldn't save that change" instead of showing an
    // optimistic state that exists nowhere.
    await expect(applyOrQueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } })).rejects.toThrow(
      'disk full',
    );
  });

  it('does not report queued:true before the write resolves', async () => {
    useNetworkStore.setState({ online: false, connected: false });

    let released = false;
    holdWrite = () => {
      // Called once the write has begun; release it on the next macrotask.
      setTimeout(() => {
        released = true;
        releaseHooks.forEach((fn) => fn());
        releaseHooks.length = 0;
      }, 0);
    };

    const result = await applyOrQueue({ kind: 'destroy', emailId: 'e1' });

    expect(result).toEqual({ queued: true });
    // The ordering assertion is the point: the write had to finish first.
    expect(released).toBe(true);
    expect(writesFinished.length).toBeGreaterThan(0);
    expect(memory.size).toBeGreaterThan(0);
  });

  it('refuses to drop an op when there is no active account', async () => {
    await useOutboxStore.getState().setAccount(null);
    await expect(
      useOutboxStore.getState().enqueue({ kind: 'destroy', emailId: 'e1' }),
    ).rejects.toThrow(/no active account/);
  });

  it('a successful enqueue really is on disk', async () => {
    await useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    const raw = memory.get('webmail:outbox:v1:' + ACCOUNT);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toHaveLength(1);
  });
});
