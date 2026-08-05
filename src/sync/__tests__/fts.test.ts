// Local FTS5 index (fts.ts, §9.4 step-9 hook). Two layers:
//
//  - Pure-function tests for `extractBodyText`/`toFtsQuery` (no driver needed).
//  - Integration tests through the real `SqliteStoreFactory` + `SqliteTxn` API —
//    the same harness shape as store-contract.test.ts — so these prove the
//    hooks actually fire from `upsertEnvelopes`/`putBodyIfEnvelopeExists`/
//    `deleteEmails`/`deleteBodies`, not just that `fts.ts`'s own SQL is correct.
//
// FTS is SQLite-only (see fts.ts's header), so unlike store-contract.test.ts
// this does not run against `MemoryStoreFactory`.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractBodyText, toFtsQuery } from '../fts';
import { SyncRegistry } from '../registry';
import { SqliteStoreFactory } from '../store-sqlite';
import type { BodyRow, EnvelopeRow, SyncStore } from '../store';
import { createTestHost } from './sqlite-test-driver';

const ACCOUNT = 'alice@mail.example';
const JA = 'jmap-account-a';

function envelope(id: string, over: Partial<EnvelopeRow> = {}): EnvelopeRow {
  return {
    jmapAccountId: JA,
    id,
    threadId: `T-${id}`,
    receivedAt: '2026-08-01T12:00:00Z',
    size: 1024,
    subject: `subject ${id}`,
    preview: 'preview',
    from: null,
    to: null,
    cc: null,
    hasAttachment: false,
    keywords: {},
    mailboxIds: { inbox: true },
    hasBody: false,
    bodyBytes: 0,
    cachedAt: 1_770_000_000_000,
    ...over,
  };
}

/** A `body.json` blob shaped like `serialiseBody()` (bodies.ts), text-part only. */
function textBodyRow(id: string, text: string, over: Partial<BodyRow> = {}): BodyRow {
  return {
    jmapAccountId: JA,
    emailId: id,
    receivedAt: '2026-08-01T12:00:00Z',
    bytes: text.length,
    json: JSON.stringify({
      textBody: [{ partId: 'p1' }],
      bodyValues: { p1: { value: text } },
    }),
    ...over,
  };
}

describe('extractBodyText', () => {
  it('prefers textBody when present', () => {
    const json = JSON.stringify({
      textBody: [{ partId: 't' }],
      htmlBody: [{ partId: 'h' }],
      bodyValues: { t: { value: 'plain text' }, h: { value: '<p>html</p>' } },
    });
    expect(extractBodyText(json)).toBe('plain text');
  });

  it('falls back to stripped htmlBody when there is no textBody', () => {
    const json = JSON.stringify({
      htmlBody: [{ partId: 'h' }],
      bodyValues: { h: { value: '<p>Hello <b>world</b></p>' } },
    });
    expect(extractBodyText(json)).toBe('Hello world');
  });

  it('returns empty string for unparseable or empty bodies', () => {
    expect(extractBodyText('not json')).toBe('');
    expect(extractBodyText('{}')).toBe('');
  });
});

describe('toFtsQuery', () => {
  it('does not throw a MATCH syntax error on reserved characters', async () => {
    const host = createTestHost();
    const registry = new SyncRegistry();
    const factory = new SqliteStoreFactory(host, registry);
    try {
      const store = await factory.open(ACCOUNT);
      await store.transaction((txn) => txn.upsertEnvelopes([envelope('E1')]));
      for (const raw of ['e-mail', 'say "hi"', 'invoice meier', '-leading-dash']) {
        await expect(factory.ftsSearch(ACCOUNT, JA, raw)).resolves.toBeDefined();
      }
    } finally {
      host.cleanup();
    }
  });

  it('wraps each word as a quoted prefix term', () => {
    expect(toFtsQuery('invoice meier')).toBe('"invoice"* "meier"*');
    expect(toFtsQuery('say "hi"')).toBe('"say"* """hi"""*');
  });
});

describe('local FTS index, wired through the real store', () => {
  let host: ReturnType<typeof createTestHost>;
  let factory: SqliteStoreFactory;
  let store: SyncStore;

  beforeEach(async () => {
    await AsyncStorage.clear();
    host = createTestHost();
    factory = new SqliteStoreFactory(host, new SyncRegistry());
    store = await factory.open(ACCOUNT);
  });

  afterEach(() => {
    host.cleanup();
  });

  it('finds a message by subject as soon as the envelope lands, before any body', async () => {
    await store.transaction((txn) =>
      txn.upsertEnvelopes([envelope('E1', { subject: 'Quarterly invoice from Meier AG' })]),
    );
    const hits = await factory.ftsSearch(ACCOUNT, JA, 'invoice');
    expect(hits.map((h) => h.id)).toEqual(['E1']);
  });

  it('finding by a body-only term does not clobber the subject match (decision 3)', async () => {
    await store.transaction(async (txn) => {
      await txn.upsertEnvelopes([envelope('E1', { subject: 'Contract renewal' })]);
      await txn.putBodyIfEnvelopeExists(
        { jmapAccountId: JA, id: 'E1' },
        textBodyRow('E1', 'please confirm the deadline of 30 September'),
      );
    });

    const byBody = await factory.ftsSearch(ACCOUNT, JA, 'deadline');
    expect(byBody.map((h) => h.id)).toEqual(['E1']);

    const bySubject = await factory.ftsSearch(ACCOUNT, JA, 'renewal');
    expect(bySubject.map((h) => h.id)).toEqual(['E1']);
  });

  it('deleteBodies clears body text but keeps subject/preview searchable', async () => {
    await store.transaction(async (txn) => {
      await txn.upsertEnvelopes([envelope('E1', { subject: 'Invoice reminder' })]);
      await txn.putBodyIfEnvelopeExists(
        { jmapAccountId: JA, id: 'E1' },
        textBodyRow('E1', 'overdue balance of CHF 480'),
      );
    });

    await store.transaction((txn) => txn.deleteBodies([{ jmapAccountId: JA, id: 'E1' }]));

    expect(await factory.ftsSearch(ACCOUNT, JA, 'overdue')).toEqual([]);
    expect((await factory.ftsSearch(ACCOUNT, JA, 'reminder')).map((h) => h.id)).toEqual(['E1']);
  });

  it('deleteEmails removes the fts row entirely', async () => {
    await store.transaction((txn) =>
      txn.upsertEnvelopes([envelope('E1', { subject: 'Temporary message' })]),
    );
    await store.transaction((txn) => txn.deleteEmails([{ jmapAccountId: JA, id: 'E1' }]));

    expect(await factory.ftsSearch(ACCOUNT, JA, 'temporary')).toEqual([]);
  });

  it('scopes results to a mailbox set', async () => {
    await store.transaction((txn) =>
      txn.upsertEnvelopes([
        envelope('IN-A', { subject: 'Meier contract', mailboxIds: { mbA: true } }),
        envelope('IN-B', { subject: 'Meier contract copy', mailboxIds: { mbB: true } }),
      ]),
    );

    const scopedToA = await factory.ftsSearch(ACCOUNT, JA, 'meier', { mailboxIds: ['mbA'] });
    expect(scopedToA.map((h) => h.id)).toEqual(['IN-A']);

    const scopedToB = await factory.ftsSearch(ACCOUNT, JA, 'meier', { mailboxIds: ['mbB'] });
    expect(scopedToB.map((h) => h.id)).toEqual(['IN-B']);

    const unscoped = await factory.ftsSearch(ACCOUNT, JA, 'meier');
    expect(new Set(unscoped.map((h) => h.id))).toEqual(new Set(['IN-A', 'IN-B']));
  });

  it('receivedAfter excludes an older message', async () => {
    await store.transaction((txn) =>
      txn.upsertEnvelopes([
        envelope('OLD', { subject: 'Meier old', receivedAt: '2026-01-01T00:00:00Z' }),
        envelope('NEW', { subject: 'Meier new', receivedAt: '2026-08-01T00:00:00Z' }),
      ]),
    );

    const hits = await factory.ftsSearch(ACCOUNT, JA, 'meier', {
      receivedAfter: '2026-06-01T00:00:00Z',
    });
    expect(hits.map((h) => h.id)).toEqual(['NEW']);
  });

  it('a message in two scoped mailboxes is returned once (GROUP BY collapse)', async () => {
    await store.transaction((txn) =>
      txn.upsertEnvelopes([
        envelope('E1', { subject: 'Meier shared', mailboxIds: { mbA: true, mbB: true } }),
      ]),
    );
    const hits = await factory.ftsSearch(ACCOUNT, JA, 'meier', { mailboxIds: ['mbA', 'mbB'] });
    expect(hits.map((h) => h.id)).toEqual(['E1']);
  });
});
