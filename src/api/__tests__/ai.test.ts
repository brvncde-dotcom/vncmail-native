import AsyncStorage from '@react-native-async-storage/async-storage';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  listLocalModels,
  testLocalConnection,
  chatLocal,
  chatPublic,
  buildPrompt,
  retrieveContext,
  type HydratedSource,
} from '../ai';
import { SyncRegistry } from '../../sync/registry';
import { SqliteStoreFactory } from '../../sync/store-sqlite';
import type { EnvelopeRow } from '../../sync/store';
import { createTestHost } from '../../sync/__tests__/sqlite-test-driver';

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

function mockFetch(status: number, json: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('listLocalModels', () => {
  it('parses installed model names', async () => {
    global.fetch = mockFetch(200, { models: [{ name: 'qwen2.5:14b' }, { name: 'llama3:8b' }] }) as any;
    const models = await listLocalModels('http://127.0.0.1:11434');
    expect(models).toEqual(['qwen2.5:14b', 'llama3:8b']);
    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags');
  });

  it('strips a trailing slash from baseUrl', async () => {
    global.fetch = mockFetch(200, { models: [] }) as any;
    await listLocalModels('http://127.0.0.1:11434/');
    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags');
  });

  it('throws on a non-2xx response', async () => {
    global.fetch = mockFetch(500, {}) as any;
    await expect(listLocalModels('http://127.0.0.1:11434')).rejects.toThrow('500');
  });
});

describe('testLocalConnection', () => {
  it('reports ok on success', async () => {
    global.fetch = mockFetch(200, { models: [] }) as any;
    expect(await testLocalConnection('http://127.0.0.1:11434')).toEqual({ ok: true });
  });

  it('reports the error message on failure, without throwing', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network unreachable');
    }) as any;
    expect(await testLocalConnection('http://127.0.0.1:11434')).toEqual({
      ok: false,
      error: 'network unreachable',
    });
  });
});

describe('chatLocal', () => {
  it('sends stream: false and returns the message content', async () => {
    global.fetch = mockFetch(200, { message: { content: 'the answer' } }) as any;
    const answer = await chatLocal('http://127.0.0.1:11434', 'qwen2.5:14b', [
      { role: 'user', content: 'hi' },
    ]);
    expect(answer).toBe('the answer');
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(JSON.parse(init.body)).toEqual({
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
  });

  it('throws when the response has no message content', async () => {
    global.fetch = mockFetch(200, {}) as any;
    await expect(chatLocal('http://127.0.0.1:11434', 'm', [])).rejects.toThrow('no message content');
  });
});

describe('chatPublic', () => {
  it('attaches a bearer token and returns the first choice', async () => {
    global.fetch = mockFetch(200, { choices: [{ message: { content: 'public answer' } }] }) as any;
    const answer = await chatPublic('https://openrouter.ai/api/v1', 'sk-test', 'model-x', [
      { role: 'user', content: 'hi' },
    ]);
    expect(answer).toBe('public answer');
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
  });

  it('throws on a non-2xx response', async () => {
    global.fetch = mockFetch(401, {}) as any;
    await expect(chatPublic('https://openrouter.ai/api/v1', 'bad-key', 'm', [])).rejects.toThrow(
      '401',
    );
  });
});

describe('buildPrompt', () => {
  it('numbers sources and appends the question', () => {
    const sources: HydratedSource[] = [
      { id: 'E1', subject: 'Invoice', text: 'please pay by Friday' },
      { id: 'E2', subject: 'Contract', text: 'deadline is 30 September' },
    ];
    const messages = buildPrompt('when is the deadline?', sources);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('[1] Subject: Invoice');
    expect(messages[1].content).toContain('[2] Subject: Contract');
    expect(messages[1].content).toContain('Question: when is the deadline?');
  });

  it('truncates long snippets rather than sending unbounded text', () => {
    const longText = 'x'.repeat(5000);
    const messages = buildPrompt('q', [{ id: 'E1', subject: 'S', text: longText }]);
    // 800-char cap (MAX_SNIPPET_CHARS) plus the "[1] Subject: S\n" prefix.
    expect(messages[1].content.length).toBeLessThan(longText.length);
  });
});

describe('retrieveContext', () => {
  let host: ReturnType<typeof createTestHost>;
  let factory: SqliteStoreFactory;

  beforeEach(async () => {
    await AsyncStorage.clear();
    host = createTestHost();
    factory = new SqliteStoreFactory(host, new SyncRegistry());
  });

  afterEach(() => {
    host.cleanup();
  });

  it('hydrates FTS hits with subject and body text, no network involved', async () => {
    const store = await factory.open(ACCOUNT);
    await store.transaction(async (txn) => {
      await txn.upsertEnvelopes([envelope('E1', { subject: 'Meier contract deadline' })]);
      await txn.putBodyIfEnvelopeExists(
        { jmapAccountId: JA, id: 'E1' },
        {
          jmapAccountId: JA,
          emailId: 'E1',
          receivedAt: '2026-08-01T12:00:00Z',
          bytes: 40,
          json: JSON.stringify({
            textBody: [{ partId: 'p1' }],
            bodyValues: { p1: { value: 'confirmed for 30 September' } },
          }),
        },
      );
    });

    const sources = await retrieveContext(ACCOUNT, JA, 'meier', 90, factory);
    expect(sources).toEqual([
      { id: 'E1', subject: 'Meier contract deadline', text: 'confirmed for 30 September' },
    ]);
  });

  it('falls back to the envelope preview when there is no body yet', async () => {
    const store = await factory.open(ACCOUNT);
    await store.transaction((txn) =>
      txn.upsertEnvelopes([
        envelope('E1', { subject: 'Meier — quick question', preview: 'no body fetched yet' }),
      ]),
    );

    const sources = await retrieveContext(ACCOUNT, JA, 'meier', 90, factory);
    expect(sources).toEqual([
      { id: 'E1', subject: 'Meier — quick question', text: 'no body fetched yet' },
    ]);
  });

  it('respects the scope-days floor', async () => {
    const store = await factory.open(ACCOUNT);
    await store.transaction((txn) =>
      txn.upsertEnvelopes([
        envelope('OLD', { subject: 'Meier archive', receivedAt: '2020-01-01T00:00:00Z' }),
      ]),
    );

    expect(await retrieveContext(ACCOUNT, JA, 'meier', 90, factory)).toEqual([]);
  });

  it('returns nothing for an account with no synced mail', async () => {
    expect(await retrieveContext(ACCOUNT, JA, 'meier', 90, factory)).toEqual([]);
  });
});
