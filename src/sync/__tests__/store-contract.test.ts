// `SyncStore` contract tests, run against BOTH backends (design §13).
//
// Running the same suite against `store-sqlite` and `store-memory` is what proves
// the §9 boundary describes behaviour rather than leaking SQLite. If a case only
// passes on one backend, either the interface is underspecified or one
// implementation is wrong — both are worth knowing before the engine is built on
// top.
//
// Scope is the storage layer only. The sync-engine-level tests (apply/coverage/
// bodies/cursor state machine, the §11 failure table) belong to later stages.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncRegistry } from '../registry';
import { SCHEMA_VERSION, STORE_FORMAT, cursorStateKey, databaseNameFor } from '../schema';
import { MemoryStoreFactory } from '../store-memory';
import { SqliteStoreFactory } from '../store-sqlite';
import {
  CorruptStateError,
  type EnvelopeRow,
  EpochMismatchError,
  type MailboxRow,
  type SyncStore,
  type SyncStoreFactory,
} from '../store';
import { asChangesState, asSnapshotState, mintEnumerationCommitment } from '../states';
import { createTestHost, hostHasDatabase } from './sqlite-test-driver';

const ACCOUNT = 'alice@mail.example';
const JA = 'jmap-account-a';
const JB = 'jmap-account-b';

function mailbox(id: string, over: Partial<MailboxRow> = {}): MailboxRow {
  return {
    jmapAccountId: JA,
    id,
    name: id,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: null,
    isSubscribed: true,
    ...over,
  };
}

function envelope(id: string, over: Partial<EnvelopeRow> = {}): EnvelopeRow {
  return {
    jmapAccountId: JA,
    id,
    threadId: `T-${id}`,
    receivedAt: '2026-08-01T12:00:00Z',
    size: 1024,
    subject: `subject ${id}`,
    preview: 'preview',
    from: [{ email: 'sender@example.com', name: 'Sender' }],
    to: [{ email: 'alice@mail.example' }],
    cc: null,
    hasAttachment: false,
    keywords: { $seen: true },
    mailboxIds: { inbox: true },
    hasBody: false,
    bodyBytes: 0,
    cachedAt: 1_770_000_000_000,
    ...over,
  };
}

function commitment(kind: 'bootstrap' | 'reconcile' = 'bootstrap', floor = '2026-07-01T00:00:00Z') {
  return mintEnumerationCommitment({
    jmapAccountId: JA,
    snapshot: asSnapshotState('snapshot-1'),
    targetFrom: floor,
    sweepFloor: floor,
    kind,
  });
}

interface Harness {
  factory: SyncStoreFactory;
  registry: SyncRegistry;
  /** Only the SQL backend has files; null for the memory backend. */
  dir: string | null;
  cleanup(): void;
}

const backends: Array<{ name: string; make(): Harness }> = [
  {
    name: 'store-sqlite',
    make(): Harness {
      const host = createTestHost();
      const registry = new SyncRegistry();
      return {
        factory: new SqliteStoreFactory(host, registry),
        registry,
        dir: host.dir,
        cleanup: () => host.cleanup(),
      };
    },
  },
  {
    name: 'store-memory',
    make(): Harness {
      const registry = new SyncRegistry();
      return {
        factory: new MemoryStoreFactory(registry),
        registry,
        dir: null,
        cleanup: () => undefined,
      };
    },
  },
];

describe.each(backends)('SyncStore contract: $name', ({ make }) => {
  let h: Harness;
  let store: SyncStore;

  beforeEach(async () => {
    // The registry lives in AsyncStorage, whose test double is module-scoped.
    await AsyncStorage.clear();
    h = make();
    store = await h.factory.open(ACCOUNT);
  });

  afterEach(() => {
    h.cleanup();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §9.5 lazy materialisation
  // ───────────────────────────────────────────────────────────────────────────

  describe('lazy materialisation (§9.5)', () => {
    it('open() materialises nothing and reads report empty', async () => {
      expect(await h.factory.isMaterialised(ACCOUNT)).toBe(false);
      expect(await store.listMailboxes(JA)).toEqual([]);
      expect(await store.queryEnvelopes({ jmapAccountId: JA, limit: 10 })).toEqual([]);
      expect(await store.getEnvelope({ jmapAccountId: JA, id: 'E1' })).toBeNull();
      expect(await store.getBody({ jmapAccountId: JA, id: 'E1' })).toBeNull();
      expect(await store.countEnvelopes()).toBe(0);
      expect(await store.bodyBytesTotal()).toBe(0);
      expect(await store.takeBodyQueue(10, Date.now())).toEqual([]);
      expect(await store.whichEnvelopesExist([{ jmapAccountId: JA, id: 'E1' }])).toEqual([]);
      expect(await store.listOrphanBodies(10)).toEqual([]);
      expect(await store.listBodiesForEviction(10)).toEqual([]);

      // An unmaterialised account still yields a usable state view, so the
      // engine bootstraps (coverage.phase 'never-run') rather than erroring.
      const state = await store.loadAccountState();
      expect(state.cursors).toEqual([]);
      expect(state.coverage).toEqual([]);
      expect(state.resyncRequired).toBe(false);
    });

    it('the first write materialises and records the format marker LAST (§8.4.1)', async () => {
      await store.transaction((txn) => txn.upsertMailboxes([mailbox('inbox')]));
      expect(await h.factory.isMaterialised(ACCOUNT)).toBe(true);
      expect(await h.factory.readFormatMarker(ACCOUNT)).toEqual({
        storeFormat: STORE_FORMAT,
        schemaVersion: SCHEMA_VERSION,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Records
  // ───────────────────────────────────────────────────────────────────────────

  describe('mailboxes', () => {
    it('upserts, patches only the count columns, and deletes', async () => {
      await store.transaction((txn) =>
        txn.upsertMailboxes([
          mailbox('inbox', { name: 'Inbox', role: 'inbox', unreadEmails: 3, sortOrder: 1 }),
          mailbox('archive', { name: 'Archive', sortOrder: 2 }),
        ]),
      );
      expect((await store.listMailboxes(JA)).map((m) => m.id)).toEqual(['inbox', 'archive']);

      // §5.2: RFC 8621 §2.2's updatedProperties optimisation patches four
      // integers instead of re-fetching every folder object.
      await store.transaction((txn) =>
        txn.patchMailboxCounts([
          { key: { jmapAccountId: JA, id: 'inbox' }, counts: { unreadEmails: 7 } },
        ]),
      );
      const [inbox] = await store.listMailboxes(JA);
      expect(inbox.unreadEmails).toBe(7);
      expect(inbox.name).toBe('Inbox'); // untouched
      expect(inbox.role).toBe('inbox');

      await store.transaction((txn) =>
        txn.deleteMailboxes([{ jmapAccountId: JA, id: 'archive' }]),
      );
      expect((await store.listMailboxes(JA)).map((m) => m.id)).toEqual(['inbox']);
    });

    it('deleting a mailbox never deletes its emails (I7, F7)', async () => {
      await store.transaction(async (txn) => {
        await txn.upsertMailboxes([mailbox('inbox')]);
        await txn.upsertEnvelopes([envelope('E1', { mailboxIds: { inbox: true } })]);
      });
      await store.transaction((txn) => txn.deleteMailboxes([{ jmapAccountId: JA, id: 'inbox' }]));

      // The envelope survives, and its membership row survives with it: §5.5
      // says a membership row referencing a missing mailbox is a normal
      // transient state, not something to repair. No FK, no cascade (§9.3).
      const e = await store.getEnvelope({ jmapAccountId: JA, id: 'E1' });
      expect(e?.id).toBe('E1');
      expect(e?.mailboxIds).toEqual({ inbox: true });
    });
  });

  describe('envelopes', () => {
    it('round-trips every field including membership', async () => {
      const row = envelope('E1', { mailboxIds: { inbox: true, flagged: true } });
      await store.transaction((txn) => txn.upsertEnvelopes([row]));
      const read = await store.getEnvelope({ jmapAccountId: JA, id: 'E1' });
      expect(read).toEqual(row);
    });

    it('drops false membership entries so both backends agree', async () => {
      await store.transaction((txn) =>
        txn.upsertEnvelopes([envelope('E1', { mailboxIds: { inbox: true, spam: false } })]),
      );
      const read = await store.getEnvelope({ jmapAccountId: JA, id: 'E1' });
      expect(read?.mailboxIds).toEqual({ inbox: true });
    });

    it('patches keywords + mailboxIds without touching the body (D1, §5.3)', async () => {
      await store.transaction(async (txn) => {
        await txn.upsertEnvelopes([envelope('E1', { keywords: {}, mailboxIds: { inbox: true } })]);
        await txn.putBodyIfEnvelopeExists(
          { jmapAccountId: JA, id: 'E1' },
          { jmapAccountId: JA, emailId: 'E1', receivedAt: '2026-08-01T12:00:00Z', json: '{"b":1}', bytes: 42 },
        );
      });

      await store.transaction((txn) =>
        txn.patchEnvelopeMutable([
          {
            key: { jmapAccountId: JA, id: 'E1' },
            keywords: { $seen: true, $flagged: true },
            mailboxIds: { archive: true },
          },
        ]),
      );

      const e = await store.getEnvelope({ jmapAccountId: JA, id: 'E1' });
      expect(e?.keywords).toEqual({ $seen: true, $flagged: true });
      expect(e?.mailboxIds).toEqual({ archive: true });
      // The body blob stays valid — bodies are immutable per RFC 8621 §4.1, so
      // an `updated` Email must never cost a body refetch.
      expect(e?.hasBody).toBe(true);
      expect(e?.bodyBytes).toBe(42);
      expect((await store.getBody({ jmapAccountId: JA, id: 'E1' }))?.json).toBe('{"b":1}');
    });

    it('patching an absent id is an unconditional no-op (F26/S16)', async () => {
      await store.transaction((txn) => txn.upsertEnvelopes([envelope('E1')]));
      await store.transaction((txn) =>
        txn.patchEnvelopeMutable([
          { key: { jmapAccountId: JA, id: 'GHOST' }, keywords: { $seen: true }, mailboxIds: { inbox: true } },
        ]),
      );
      expect(await store.getEnvelope({ jmapAccountId: JA, id: 'GHOST' })).toBeNull();
      expect(await store.countEnvelopes()).toBe(1);
      // Critically, no membership row was created for a record we do not hold.
      expect(await store.queryEnvelopes({ jmapAccountId: JA, mailboxId: 'inbox', limit: 10 })).toHaveLength(1);
    });

    it('re-upserting an envelope does not clobber has_body (I5 replay)', async () => {
      const row = envelope('E1');
      await store.transaction(async (txn) => {
        await txn.upsertEnvelopes([row]);
        await txn.putBodyIfEnvelopeExists(
          { jmapAccountId: JA, id: 'E1' },
          { jmapAccountId: JA, emailId: 'E1', receivedAt: row.receivedAt, json: '{}', bytes: 99 },
        );
      });
      // A crash mid-drain replays the page (I1/I5). If the replay reset
      // has_body, job C2 would re-download every body in the page.
      await store.transaction((txn) => txn.upsertEnvelopes([row]));
      const e = await store.getEnvelope({ jmapAccountId: JA, id: 'E1' });
      expect(e?.hasBody).toBe(true);
      expect(e?.bodyBytes).toBe(99);
    });

    it('whichEnvelopesExist filters absent ids before a fetch is issued (§5.3)', async () => {
      await store.transaction((txn) =>
        txn.upsertEnvelopes([envelope('E1'), envelope('E2'), envelope('E3', { jmapAccountId: JB })]),
      );
      const present = await store.whichEnvelopesExist([
        { jmapAccountId: JA, id: 'E1' },
        { jmapAccountId: JA, id: 'GHOST' },
        { jmapAccountId: JB, id: 'E3' },
        { jmapAccountId: JB, id: 'E1' },
      ]);
      expect(present).toEqual([
        { jmapAccountId: JA, id: 'E1' },
        { jmapAccountId: JB, id: 'E3' },
      ]);
    });

    it('deleteEmails removes envelope, body, membership and queue rows', async () => {
      await store.transaction(async (txn) => {
        await txn.upsertEnvelopes([envelope('E1')]);
        await txn.enqueueBodies([
          { jmapAccountId: JA, emailId: 'E1', receivedAt: '2026-08-01T12:00:00Z', attempts: 0 },
        ]);
        await txn.putBodyIfEnvelopeExists(
          { jmapAccountId: JA, id: 'E1' },
          { jmapAccountId: JA, emailId: 'E1', receivedAt: '2026-08-01T12:00:00Z', json: '{}', bytes: 10 },
        );
      });
      await store.transaction((txn) => txn.deleteEmails([{ jmapAccountId: JA, id: 'E1' }]));

      expect(await store.getEnvelope({ jmapAccountId: JA, id: 'E1' })).toBeNull();
      expect(await store.getBody({ jmapAccountId: JA, id: 'E1' })).toBeNull();
      expect(await store.takeBodyQueue(10, Date.now())).toEqual([]);
      expect(await store.queryEnvelopes({ jmapAccountId: JA, mailboxId: 'inbox', limit: 10 })).toEqual([]);
      // No orphan left behind.
      expect(await store.listOrphanBodies(10)).toEqual([]);
    });
  });

  describe('bodies', () => {
    it('refuses to write a body for a destroyed envelope (F48)', async () => {
      const wrote = await store.transaction((txn) =>
        txn.putBodyIfEnvelopeExists(
          { jmapAccountId: JA, id: 'E1' },
          { jmapAccountId: JA, emailId: 'E1', receivedAt: '2026-08-01T12:00:00Z', json: '{}', bytes: 5 },
        ),
      );
      expect(wrote).toBe(false);
      expect(await store.getBody({ jmapAccountId: JA, id: 'E1' })).toBeNull();
      expect(await store.bodyBytesTotal()).toBe(0);
    });

    it('a successful body write dequeues its queue entry', async () => {
      await store.transaction(async (txn) => {
        await txn.upsertEnvelopes([envelope('E1')]);
        await txn.enqueueBodies([
          { jmapAccountId: JA, emailId: 'E1', receivedAt: '2026-08-01T12:00:00Z', attempts: 2 },
        ]);
        const wrote = await txn.putBodyIfEnvelopeExists(
          { jmapAccountId: JA, id: 'E1' },
          { jmapAccountId: JA, emailId: 'E1', receivedAt: '2026-08-01T12:00:00Z', json: '{}', bytes: 5 },
        );
        expect(wrote).toBe(true);
      });
      expect(await store.takeBodyQueue(10, Date.now())).toEqual([]);
    });

    it('deleteBodies keeps the envelope listed and openable (F24B)', async () => {
      await store.transaction(async (txn) => {
        await txn.upsertEnvelopes([envelope('E1')]);
        await txn.putBodyIfEnvelopeExists(
          { jmapAccountId: JA, id: 'E1' },
          { jmapAccountId: JA, emailId: 'E1', receivedAt: '2026-08-01T12:00:00Z', json: '{}', bytes: 7 },
        );
      });
      await store.transaction((txn) => txn.deleteBodies([{ jmapAccountId: JA, id: 'E1' }]));

      const e = await store.getEnvelope({ jmapAccountId: JA, id: 'E1' });
      expect(e?.hasBody).toBe(false);
      expect(e?.bodyBytes).toBe(0);
      expect(await store.bodyBytesTotal()).toBe(0);
    });

    it('evicts oldest-body-first from the body table alone (F25/S12)', async () => {
      await store.transaction(async (txn) => {
        for (const [id, at, bytes] of [
          ['E1', '2026-08-01T00:00:00Z', 100],
          ['E2', '2026-06-01T00:00:00Z', 200],
          ['E3', '2026-07-01T00:00:00Z', 300],
        ] as const) {
          await txn.upsertEnvelopes([envelope(id, { receivedAt: at })]);
          await txn.putBodyIfEnvelopeExists(
            { jmapAccountId: JA, id },
            { jmapAccountId: JA, emailId: id, receivedAt: at, json: '{}', bytes },
          );
        }
      });
      expect(await store.bodyBytesTotal()).toBe(600);
      const order = (await store.listBodiesForEviction(10)).map((b) => b.key.id);
      expect(order).toEqual(['E2', 'E3', 'E1']);
    });

    it('normal operations never produce an orphan body (F45)', async () => {
      await store.transaction(async (txn) => {
        await txn.upsertEnvelopes([envelope('E1'), envelope('E2')]);
        for (const id of ['E1', 'E2']) {
          await txn.putBodyIfEnvelopeExists(
            { jmapAccountId: JA, id },
            { jmapAccountId: JA, emailId: id, receivedAt: '2026-08-01T12:00:00Z', json: '{}', bytes: 10 },
          );
        }
      });
      // The two guards that make this true: putBodyIfEnvelopeExists refuses to
      // write a body whose envelope is gone, and deleteEmails takes the body
      // with it. listOrphanBodies is the backstop for anything that ever
      // bypasses both (exercised against raw SQL below).
      await store.transaction((txn) => txn.deleteEmails([{ jmapAccountId: JA, id: 'E1' }]));
      expect(await store.listOrphanBodies(10)).toEqual([]);
      expect(await store.bodyBytesTotal()).toBe(10);
    });
  });

  describe('body queue (S12)', () => {
    const entry = (id: string, over: Partial<{ attempts: number; nextAttemptAt: number; receivedAt: string }> = {}) => ({
      jmapAccountId: JA,
      emailId: id,
      receivedAt: over.receivedAt ?? '2026-08-01T12:00:00Z',
      attempts: over.attempts ?? 0,
      nextAttemptAt: over.nextAttemptAt,
    });

    it('re-enqueue is insert-or-ignore and NEVER resets attempts (F41)', async () => {
      await store.transaction((txn) => txn.enqueueBodies([entry('E1', { attempts: 0 })]));
      await store.transaction((txn) =>
        txn.updateBodyQueue([{ ...entry('E1'), attempts: 4, lastError: 'boom' }]),
      );
      // Job C2 re-enqueuing a permanently failing body must not buy it five
      // fresh attempts, or the give-up rule never fires.
      await store.transaction((txn) => txn.enqueueBodies([entry('E1', { attempts: 0 })]));

      const [q] = await store.takeBodyQueue(10, Date.now());
      expect(q.attempts).toBe(4);
      expect(q.lastError).toBe('boom');
    });

    it('honours nextAttemptAt and orders newest-first', async () => {
      const now = 1_770_000_000_000;
      await store.transaction((txn) =>
        txn.enqueueBodies([
          entry('OLD', { receivedAt: '2026-06-01T00:00:00Z' }),
          entry('NEW', { receivedAt: '2026-08-01T00:00:00Z' }),
          entry('LATER', { receivedAt: '2026-09-01T00:00:00Z', nextAttemptAt: now + 60_000 }),
        ]),
      );
      expect((await store.takeBodyQueue(10, now)).map((e) => e.emailId)).toEqual(['NEW', 'OLD']);
      expect((await store.takeBodyQueue(10, now + 60_000)).map((e) => e.emailId)).toEqual([
        'LATER',
        'NEW',
        'OLD',
      ]);
    });

    it('dequeues immediately on notFound (F40)', async () => {
      await store.transaction((txn) => txn.enqueueBodies([entry('E1')]));
      await store.transaction((txn) => txn.dequeueBodies([{ jmapAccountId: JA, id: 'E1' }]));
      expect(await store.takeBodyQueue(10, Date.now())).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Queries
  // ───────────────────────────────────────────────────────────────────────────

  describe('queryEnvelopes', () => {
    beforeEach(async () => {
      await store.transaction((txn) =>
        txn.upsertEnvelopes([
          envelope('E1', { receivedAt: '2026-08-03T00:00:00Z', mailboxIds: { inbox: true } }),
          envelope('E2', { receivedAt: '2026-08-02T00:00:00Z', mailboxIds: { inbox: true, work: true } }),
          envelope('E3', { receivedAt: '2026-08-01T00:00:00Z', mailboxIds: { archive: true } }),
          envelope('E4', { receivedAt: '2026-08-04T00:00:00Z', jmapAccountId: JB, mailboxIds: { inbox: true } }),
        ]),
      );
    });

    it('filters by mailbox — the index seek that closes D3', async () => {
      expect((await store.queryEnvelopes({ jmapAccountId: JA, mailboxId: 'inbox', limit: 10 })).map((e) => e.id)).toEqual(['E1', 'E2']);
      expect((await store.queryEnvelopes({ jmapAccountId: JA, mailboxId: 'work', limit: 10 })).map((e) => e.id)).toEqual(['E2']);
      // A sparse/empty folder is the case D3 was actually about.
      expect(await store.queryEnvelopes({ jmapAccountId: JA, mailboxId: 'nothing-here', limit: 10 })).toEqual([]);
    });

    it('never crosses JMAP accounts (S3/I6)', async () => {
      expect((await store.queryEnvelopes({ jmapAccountId: JA, limit: 10 })).map((e) => e.id)).toEqual(['E1', 'E2', 'E3']);
      expect((await store.queryEnvelopes({ jmapAccountId: JB, limit: 10 })).map((e) => e.id)).toEqual(['E4']);
    });

    it('receivedAfter is inclusive and receivedBefore exclusive (S14)', async () => {
      expect(
        (await store.queryEnvelopes({ jmapAccountId: JA, receivedAfter: '2026-08-02T00:00:00Z', limit: 10 })).map((e) => e.id),
      ).toEqual(['E1', 'E2']);
      expect(
        (await store.queryEnvelopes({ jmapAccountId: JA, receivedBefore: '2026-08-02T00:00:00Z', limit: 10 })).map((e) => e.id),
      ).toEqual(['E3']);
    });

    it('hasBody:false drives job C2 (S9)', async () => {
      await store.transaction((txn) =>
        txn.putBodyIfEnvelopeExists(
          { jmapAccountId: JA, id: 'E1' },
          { jmapAccountId: JA, emailId: 'E1', receivedAt: '2026-08-03T00:00:00Z', json: '{}', bytes: 8 },
        ),
      );
      expect(
        (await store.queryEnvelopes({ jmapAccountId: JA, hasBody: false, limit: 10 })).map((e) => e.id),
      ).toEqual(['E2', 'E3']);
      expect(
        (await store.queryEnvelopes({ jmapAccountId: JA, hasBody: true, limit: 10 })).map((e) => e.id),
      ).toEqual(['E1']);
    });

    it('paginates deterministically', async () => {
      expect((await store.queryEnvelopes({ jmapAccountId: JA, limit: 2 })).map((e) => e.id)).toEqual(['E1', 'E2']);
      expect((await store.queryEnvelopes({ jmapAccountId: JA, limit: 2, offset: 2 })).map((e) => e.id)).toEqual(['E3']);
    });

    it('counts by account and by mailbox', async () => {
      expect(await store.countEnvelopes()).toBe(4);
      expect(await store.countEnvelopes({ jmapAccountId: JA })).toBe(3);
      expect(await store.countEnvelopes({ jmapAccountId: JA, mailboxId: 'inbox' })).toBe(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Cursors and coverage (§3.2, §7.5)
  // ───────────────────────────────────────────────────────────────────────────

  describe('cursors', () => {
    it('seedCursor writes the cursor AND its coverage commitment in one txn (§3.2)', async () => {
      await store.transaction((txn) => txn.seedCursor({ jmapAccountId: JA, type: 'Email' }, commitment()));

      const state = await store.loadAccountState();
      expect(state.cursors).toHaveLength(1);
      expect(state.cursors[0]).toMatchObject({
        type: 'Email',
        jmapAccountId: JA,
        state: 'snapshot-1',
        drainPending: false,
        consecutiveFailures: 0,
        maxChangesRung: 0,
      });
      expect(state.coverage).toHaveLength(1);
      expect(state.coverage[0]).toMatchObject({
        jmapAccountId: JA,
        phase: 'scanning',
        targetFrom: '2026-07-01T00:00:00Z',
        sweepFloor: '2026-07-01T00:00:00Z',
        scanCursor: null,
        coveredFrom: null,
      });
    });

    it('a reconcile seed enters phase reconciling and pins its own floor (S2)', async () => {
      await store.transaction((txn) => txn.seedCursor({ jmapAccountId: JA, type: 'Email' }, commitment()));
      await store.transaction((txn) =>
        txn.patchCoverage(JA, { coveredFrom: '2026-07-01T00:00:00Z', phase: 'complete' }),
      );
      await store.transaction((txn) =>
        txn.seedCursor(
          { jmapAccountId: JA, type: 'Email' },
          commitment('reconcile', '2026-05-01T00:00:00Z'),
        ),
      );
      const [coverage] = (await store.loadAccountState()).coverage;
      expect(coverage.phase).toBe('reconciling');
      expect(coverage.sweepFloor).toBe('2026-05-01T00:00:00Z');
      // Records stay readable during the rebuild, so what was already covered
      // stays claimed until §7.6 step 5.
      expect(coverage.coveredFrom).toBe('2026-07-01T00:00:00Z');
    });

    it('advanceCursor moves a seeded cursor forward', async () => {
      const key = { jmapAccountId: JA, type: 'Email' } as const;
      await store.transaction((txn) => txn.seedCursor(key, commitment()));
      await store.transaction((txn) => txn.advanceCursor(key, asChangesState('changes-2')));
      expect((await store.loadAccountState()).cursors[0].state).toBe('changes-2');
    });

    it('advanceCursor refuses to invent a cursor from nowhere (I2/I3)', async () => {
      await expect(
        store.transaction((txn) =>
          txn.advanceCursor({ jmapAccountId: JA, type: 'Email' }, asChangesState('changes-1')),
        ),
      ).rejects.toThrow(/seed it first/);
      expect((await store.loadAccountState()).cursors).toEqual([]);
    });

    it('patchCoverage refuses to run before a commitment exists', async () => {
      await expect(
        store.transaction((txn) => txn.patchCoverage(JA, { seen: 5 })),
      ).rejects.toThrow(/seed it first/);
    });

    it('keeps cursors per (jmapAccountId, type) — all three keys are required (§3.1)', async () => {
      await store.transaction(async (txn) => {
        await txn.seedCursor({ jmapAccountId: JA, type: 'Email' }, commitment());
        await txn.seedCursor({ jmapAccountId: JA, type: 'Mailbox' }, commitment());
      });
      await store.transaction((txn) =>
        txn.advanceCursor({ jmapAccountId: JA, type: 'Email' }, asChangesState('email-2')),
      );
      const state = await store.loadAccountState();
      const byType = Object.fromEntries(state.cursors.map((c) => [c.type, c.state]));
      expect(byType).toEqual({ Email: 'email-2', Mailbox: 'snapshot-1' });
    });

    it('patchCursor carries the per-cursor anti-wedge counters (S6)', async () => {
      const key = { jmapAccountId: JA, type: 'Email' } as const;
      await store.transaction((txn) => txn.seedCursor(key, commitment()));
      await store.transaction((txn) =>
        txn.patchCursor(key, {
          consecutiveFailures: 3,
          lastFailedState: 'snapshot-1',
          maxChangesRung: 2,
          drainPending: true,
          invalidatedAt: 123,
          invalidatedReason: 'cannotCalculateChanges',
        }),
      );
      const [cursor] = (await store.loadAccountState()).cursors;
      expect(cursor).toMatchObject({
        state: 'snapshot-1', // the patch cannot move the cursor
        consecutiveFailures: 3,
        lastFailedState: 'snapshot-1',
        maxChangesRung: 2,
        drainPending: true,
        invalidatedReason: 'cannotCalculateChanges',
      });
    });
  });

  describe('account flags', () => {
    it('patches individual fields without a whole-struct write (I12)', async () => {
      await store.transaction((txn) => txn.patchAccountFlags({ resyncRequired: true }));
      await store.transaction((txn) => txn.patchAccountFlags({ reconcilesInWindow: 2 }));
      const state = await store.loadAccountState();
      expect(state.resyncRequired).toBe(true);
      expect(state.reconcilesInWindow).toBe(2);
      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    });

    it('carries lastCycle and lastWindowFloor', async () => {
      await store.transaction((txn) =>
        txn.patchAccountFlags({
          lastWindowFloor: '2026-07-01T00:00:00Z',
          lastCycle: { startedAt: 1, finishedAt: 2, outcome: 'partial', madeProgress: true },
        }),
      );
      const state = await store.loadAccountState();
      expect(state.lastCycle).toEqual({
        startedAt: 1,
        finishedAt: 2,
        outcome: 'partial',
        madeProgress: true,
      });
      expect(state.lastWindowFloor).toBe('2026-07-01T00:00:00Z');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Transactions, epochs, clearRecords, purge
  // ───────────────────────────────────────────────────────────────────────────

  describe('transaction atomicity (I1/I4)', () => {
    it('commits nothing when the body of the transaction throws', async () => {
      await store.transaction((txn) => txn.seedCursor({ jmapAccountId: JA, type: 'Email' }, commitment()));

      await expect(
        store.transaction(async (txn) => {
          await txn.upsertEnvelopes([envelope('E1')]);
          await txn.advanceCursor({ jmapAccountId: JA, type: 'Email' }, asChangesState('changes-2'));
          throw new Error('storage write failed');
        }),
      ).rejects.toThrow('storage write failed');

      // Cursor-last is the rule, but the transaction is what enforces it: a
      // failed page leaves NEITHER the records nor the cursor advanced (F30).
      expect(await store.getEnvelope({ jmapAccountId: JA, id: 'E1' })).toBeNull();
      expect((await store.loadAccountState()).cursors[0].state).toBe('snapshot-1');
    });

    it('a later successful transaction still lands after a rollback', async () => {
      await expect(
        store.transaction(async (txn) => {
          await txn.upsertEnvelopes([envelope('E1')]);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await store.transaction((txn) => txn.upsertEnvelopes([envelope('E2')]));
      expect((await store.queryEnvelopes({ jmapAccountId: JA, limit: 10 })).map((e) => e.id)).toEqual(['E2']);
    });

    it('serialises concurrent transactions (the per-account mutex, S1)', async () => {
      await store.transaction((txn) => txn.patchAccountFlags({ reconcilesInWindow: 0 }));
      // Two read-merge-write increments must not lose one another.
      await Promise.all([
        store.transaction(async (txn) => {
          const before = (await store.loadAccountState()).reconcilesInWindow;
          await txn.patchAccountFlags({ reconcilesInWindow: before + 1 });
        }),
        store.transaction(async (txn) => {
          const before = (await store.loadAccountState()).reconcilesInWindow;
          await txn.patchAccountFlags({ reconcilesInWindow: before + 1 });
        }),
      ]);
      expect((await store.loadAccountState()).reconcilesInWindow).toBe(2);
    });
  });

  describe('epoch guard (§8.3, F21/F22)', () => {
    it('rejects a commit after the epoch moved under it', async () => {
      await store.transaction((txn) => txn.upsertEnvelopes([envelope('E1')]));
      await h.registry.bumpEpoch(ACCOUNT, 'switchAccount');

      await expect(
        store.transaction((txn) => txn.upsertEnvelopes([envelope('E2')])),
      ).rejects.toBeInstanceOf(EpochMismatchError);
      expect((await store.queryEnvelopes({ jmapAccountId: JA, limit: 10 })).map((e) => e.id)).toEqual(['E1']);
    });

    it('rejects a commit when the epoch moves mid-transaction', async () => {
      // The generalisation of jmapClientServesActiveAccount: the check runs
      // before EVERY commit, not just at cycle start, because a cycle is
      // long-lived and switchAccount can land in the middle of it (D6).
      await expect(
        store.transaction(async (txn) => {
          await txn.upsertEnvelopes([envelope('E1')]);
          await h.registry.bumpEpoch(ACCOUNT, 'switchAccount mid-cycle');
        }),
      ).rejects.toBeInstanceOf(EpochMismatchError);
      expect(await store.countEnvelopes()).toBe(0);
    });

    it('the epoch is monotonic across a purge (§8.3)', async () => {
      await store.transaction((txn) => txn.upsertEnvelopes([envelope('E1')]));
      const before = await h.factory.epochFor(ACCOUNT);
      await h.factory.purgeAccount(ACCOUNT, 'logout');
      expect(await h.factory.epochFor(ACCOUNT)).toBeGreaterThan(before);
    });
  });

  describe('clearRecords (F35/F37)', () => {
    it('wipes records and the body queue, keeps cursors, sets resyncRequired', async () => {
      await store.transaction(async (txn) => {
        await txn.seedCursor({ jmapAccountId: JA, type: 'Email' }, commitment());
        await txn.advanceCursor({ jmapAccountId: JA, type: 'Email' }, asChangesState('changes-9'));
        await txn.upsertMailboxes([mailbox('inbox')]);
        await txn.upsertEnvelopes([envelope('E1')]);
        await txn.enqueueBodies([
          { jmapAccountId: JA, emailId: 'E1', receivedAt: '2026-08-01T12:00:00Z', attempts: 1 },
        ]);
      });

      await store.clearRecords();

      expect(await store.countEnvelopes()).toBe(0);
      expect(await store.listMailboxes(JA)).toEqual([]);
      expect(await store.takeBodyQueue(10, Date.now())).toEqual([]);
      const state = await store.loadAccountState();
      expect(state.resyncRequired).toBe(true);
      // §7.5 rule 7: a Settings "clear cache" clears RECORDS and sets
      // resyncRequired; it does not null the cursor.
      expect(state.cursors[0].state).toBe('changes-9');
    });

    it('bumps the epoch so an in-flight cycle cannot write over it (S1/F37)', async () => {
      const stale = store;
      await stale.transaction((txn) => txn.patchAccountFlags({ resyncRequired: false }));

      // A second holder of the same account — the shape of "a cycle loaded the
      // state, the user tapped Clear cache, the cycle wrote its stale copy
      // back". A whole-struct AccountSyncState write would have produced an
      // empty store with a live cursor and no resync pending; the epoch bump
      // plus field-level patches make it unreachable.
      const other = await make().factory.open(ACCOUNT);
      await other.clearRecords();

      await expect(
        stale.transaction((txn) => txn.patchAccountFlags({ resyncRequired: false })),
      ).rejects.toBeInstanceOf(EpochMismatchError);
    });
  });

  describe('purge (§8.4, F4/F22)', () => {
    it('removes every trace and leaves the account ready to bootstrap', async () => {
      await store.transaction(async (txn) => {
        await txn.seedCursor({ jmapAccountId: JA, type: 'Email' }, commitment());
        await txn.upsertEnvelopes([envelope('E1')]);
      });
      expect(await h.factory.isMaterialised(ACCOUNT)).toBe(true);

      await h.factory.purgeAccount(ACCOUNT, 'logout');

      expect(await h.factory.isMaterialised(ACCOUNT)).toBe(false);
      expect(await h.factory.readFormatMarker(ACCOUNT)).toBeNull();
      expect(await h.factory.listAccounts()).toEqual([]);

      // A stale cursor surviving a purge would be catastrophic: it would be
      // advanced against a freshly-empty store, skipping changes no /changes
      // page will ever re-report (§8.1).
      const reopened = await h.factory.open(ACCOUNT);
      const state = await reopened.loadAccountState();
      expect(state.cursors).toEqual([]);
      expect(state.coverage).toEqual([]);
      expect(await reopened.countEnvelopes()).toBe(0);
    });

    it('completes a purge interrupted before it finished, at launch (F4)', async () => {
      await store.transaction((txn) => txn.upsertEnvelopes([envelope('E1')]));
      // Crash between §8.4 step 1 and step 5.
      await h.registry.markPurgePending(ACCOUNT);

      await h.factory.completePendingPurges();

      expect(await h.factory.isMaterialised(ACCOUNT)).toBe(false);
      const reopened = await h.factory.open(ACCOUNT);
      expect(await reopened.countEnvelopes()).toBe(0);
      expect((await reopened.loadAccountState()).cursors).toEqual([]);
    });

    it('only purges the account asked for (§8.1 namespacing, I6)', async () => {
      const other = 'bob@mail.example';
      const otherStore = await h.factory.open(other);
      await store.transaction((txn) => txn.upsertEnvelopes([envelope('E1')]));
      await otherStore.transaction((txn) => txn.upsertEnvelopes([envelope('E9')]));

      await h.factory.purgeAccount(ACCOUNT, 'logout');

      expect(await h.factory.isMaterialised(other)).toBe(true);
      expect(await (await h.factory.open(other)).countEnvelopes()).toBe(1);
    });
  });

  describe('store-format marker (§8.4.1, V4)', () => {
    it('purges on a schemaVersion mismatch, before any cycle', async () => {
      await store.transaction((txn) => txn.upsertEnvelopes([envelope('E1')]));
      await h.factory.writeFormatMarker(ACCOUNT, {
        storeFormat: STORE_FORMAT,
        schemaVersion: SCHEMA_VERSION + 1,
      });

      await h.factory.completePendingPurges();

      expect(await h.factory.isMaterialised(ACCOUNT)).toBe(false);
      expect(await (await h.factory.open(ACCOUNT)).countEnvelopes()).toBe(0);
    });

    it('purges on a storeFormat mismatch — the encryption flip', async () => {
      await store.transaction((txn) => txn.upsertEnvelopes([envelope('E1')]));
      // The trigger cannot be read out of the file, which is the whole reason
      // the marker is out of band: `schemaVersion` lives INSIDE the database the
      // flip makes unreadable.
      await h.factory.writeFormatMarker(ACCOUNT, {
        storeFormat: 'sqlite-cipher',
        schemaVersion: SCHEMA_VERSION,
      });

      await h.factory.completePendingPurges();

      expect(await h.factory.isMaterialised(ACCOUNT)).toBe(false);
    });

    it('leaves a matching marker alone', async () => {
      await store.transaction((txn) => txn.upsertEnvelopes([envelope('E1')]));
      await h.factory.completePendingPurges();
      expect(await h.factory.isMaterialised(ACCOUNT)).toBe(true);
      expect(await (await h.factory.open(ACCOUNT)).countEnvelopes()).toBe(1);
    });

    it('an account with no store at all is not a mismatch — it bootstraps', async () => {
      await h.registry.bumpEpoch(ACCOUNT, 'login'); // an entry with no marker
      await h.factory.completePendingPurges();
      expect(await h.factory.isMaterialised(ACCOUNT)).toBe(false);
      expect((await (await h.factory.open(ACCOUNT)).loadAccountState()).coverage).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SQL-backend-only cases
// ─────────────────────────────────────────────────────────────────────────────

describe('store-sqlite specifics', () => {
  let host: ReturnType<typeof createTestHost>;
  let registry: SyncRegistry;
  let factory: SqliteStoreFactory;

  beforeEach(async () => {
    await AsyncStorage.clear();
    host = createTestHost();
    registry = new SyncRegistry();
    factory = new SqliteStoreFactory(host, registry);
  });

  afterEach(() => host.cleanup());

  it('creates no database file until the first write (§9.5)', async () => {
    const store = await factory.open(ACCOUNT);
    await store.listMailboxes(JA);
    await store.queryEnvelopes({ jmapAccountId: JA, limit: 5 });
    expect(hostHasDatabase(host.dir, databaseNameFor(ACCOUNT))).toBe(false);

    await store.transaction((txn) => txn.upsertMailboxes([mailbox('inbox')]));
    expect(hostHasDatabase(host.dir, databaseNameFor(ACCOUNT))).toBe(true);
  });

  it('a purge deletes the file, not just the rows (§8.4 step 4)', async () => {
    const store = await factory.open(ACCOUNT);
    await store.transaction((txn) => txn.upsertEnvelopes([envelope('E1')]));
    expect(hostHasDatabase(host.dir, databaseNameFor(ACCOUNT))).toBe(true);

    await factory.purgeAccount(ACCOUNT, 'logout');
    expect(hostHasDatabase(host.dir, databaseNameFor(ACCOUNT))).toBe(false);
  });

  it('sync_state lives in the same file as the records, so a wipe takes both (§9.3)', async () => {
    const store = await factory.open(ACCOUNT);
    await store.transaction(async (txn) => {
      await txn.seedCursor({ jmapAccountId: JA, type: 'Email' }, commitment());
      await txn.upsertEnvelopes([envelope('E1')]);
    });
    await factory.purgeAccount(ACCOUNT, 'logout');

    const reopened = await factory.open(ACCOUNT);
    expect((await reopened.loadAccountState()).cursors).toEqual([]);
    expect(await reopened.countEnvelopes()).toBe(0);
  });

  it('state survives a reopen — the crash-recovery precondition (F1/F3)', async () => {
    const store = await factory.open(ACCOUNT);
    await store.transaction(async (txn) => {
      await txn.seedCursor({ jmapAccountId: JA, type: 'Email' }, commitment());
      await txn.advanceCursor({ jmapAccountId: JA, type: 'Email' }, asChangesState('changes-7'));
      await txn.patchCursor({ jmapAccountId: JA, type: 'Email' }, { drainPending: true });
      await txn.patchCoverage(JA, { scanCursor: '2026-07-15T00:00:00Z', seen: 120 });
      await txn.upsertEnvelopes([envelope('E1')]);
    });

    // A fresh factory over the same directory is this test's stand-in for a
    // relaunch after an OS kill.
    const relaunched = new SqliteStoreFactory(host, new SyncRegistry());
    const store2 = await relaunched.open(ACCOUNT);
    const state = await store2.loadAccountState();
    expect(state.cursors[0]).toMatchObject({ state: 'changes-7', drainPending: true });
    expect(state.coverage[0]).toMatchObject({ scanCursor: '2026-07-15T00:00:00Z', seen: 120 });
    expect(await store2.countEnvelopes()).toBe(1);
  });

  it('sweeps an orphan body that bypassed both guards (F45)', async () => {
    const store = await factory.open(ACCOUNT);
    await store.transaction((txn) => txn.upsertEnvelopes([envelope('E1')]));

    // Forced at the SQL level, because the interface deliberately makes this
    // unreachable. Otherwise the row would consume the user's storage cap while
    // being invisible to eviction, which only walks the body table.
    const db = await host.open(databaseNameFor(ACCOUNT));
    await db.runAsync(
      'INSERT INTO body (jmap_account_id, email_id, received_at, json, bytes) VALUES (?,?,?,?,?)',
      [JA, 'ORPHAN', '2026-01-01T00:00:00Z', '{}', 500],
    );

    expect(await store.listOrphanBodies(10)).toEqual([{ jmapAccountId: JA, id: 'ORPHAN' }]);
    await store.transaction((txn) => txn.deleteBodies([{ jmapAccountId: JA, id: 'ORPHAN' }]));
    expect(await store.listOrphanBodies(10)).toEqual([]);
    expect(await store.bodyBytesTotal()).toBe(0);
  });

  it('raises CorruptStateError rather than reporting an empty cursor set (I13/F43)', async () => {
    const store = await factory.open(ACCOUNT);
    await store.transaction((txn) => txn.seedCursor({ jmapAccountId: JA, type: 'Email' }, commitment()));

    // Only the serialising backend can express this: store-memory holds live
    // objects, so there is no blob to corrupt.
    const db = await host.open(databaseNameFor(ACCOUNT));
    await db.runAsync('UPDATE sync_state SET v = ? WHERE k = ?', [
      '{not json',
      cursorStateKey(JA, 'Email'),
    ]);

    await expect(store.loadAccountState()).rejects.toBeInstanceOf(CorruptStateError);
  });
});
