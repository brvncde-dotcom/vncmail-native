// The AI assistant's wire client — prototype scope (see the plan committed alongside
// this: local Ollama + BYOK public, no VNC-hosted `server` class, no streaming).
//
// Deliberately bypasses `secureFetch` (client-cert.ts): that machinery pins to the
// customer's JMAP server over mTLS, which has nothing to do with a loopback dev
// runtime or a public LLM API. Plain `fetch` is unconditionally what `secureFetch`
// reduces to on iOS anyway (see client-cert.ts's own header), so there is no
// behavioural difference — this just doesn't pretend the indirection is needed.

import { getAiApiKey } from '../lib/ai-key-store';
import { useAccountStore } from '../stores/account-store';
import { useSettingsStore } from '../stores/settings-store';
import { jmapClient } from './jmap-client';
import { extractBodyText } from '../sync/fts';
import { sqliteStoreFactory, type SqliteStoreFactory } from '../sync/store-sqlite';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ── Local: Ollama's native API, not the OpenAI-compat shim — one fewer path
// assumption (no "/v1" prefix to guess at) for a runtime this code talks to directly. ──

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

export async function listLocalModels(baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`);
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const body = (await res.json()) as OllamaTagsResponse;
  return (body.models ?? []).map((m) => m.name).filter(Boolean);
}

export async function testLocalConnection(
  baseUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await listLocalModels(baseUrl);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function chatLocal(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const body = (await res.json()) as OllamaChatResponse;
  const content = body.message?.content;
  if (!content) throw new Error('Ollama returned no message content');
  return content;
}

// ── Public: OpenAI-compatible chat-completions. OpenRouter by default, but any
// endpoint speaking this shape works unmodified (self-hosted vLLM, LiteLLM, etc). ──

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export async function chatPublic(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) throw new Error(`Provider returned ${res.status}`);
  const body = (await res.json()) as OpenAiChatResponse;
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('Provider returned no message content');
  return content;
}

// ── The actual loop: retrieve locally, prompt whichever provider is active. ──

const MAX_SOURCES = 6;
const MAX_SNIPPET_CHARS = 800;

export interface AskSource {
  id: string;
  subject: string;
}

export interface AskResult {
  answer: string;
  sources: AskSource[];
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export interface HydratedSource extends AskSource {
  text: string;
}

/**
 * The retrieval half of the loop, split out so it's testable against real
 * seeded data (the `SqliteStoreFactory` + `createTestHost` harness from
 * `fts.test.ts`) without touching the network — `askLocalMail` is thin glue
 * on top of this plus `buildPrompt` plus whichever `chat*` function.
 */
export async function retrieveContext(
  accountId: string,
  jmapAccountId: string,
  question: string,
  scopeDays: number,
  // Injectable for tests (same `overrides`-default idiom as offline-reads.ts's
  // `deps()`) — the real singleton's default host is expo-sqlite's native
  // module, which doesn't exist under vitest.
  factory: SqliteStoreFactory = sqliteStoreFactory,
): Promise<HydratedSource[]> {
  const hits = await factory.ftsSearch(accountId, jmapAccountId, question, {
    receivedAfter: daysAgoIso(scopeDays),
    limit: MAX_SOURCES,
  });

  const store = await factory.open(accountId);
  const hydrated: HydratedSource[] = [];
  for (const hit of hits) {
    const key = { jmapAccountId, id: hit.id };
    const envelope = await store.getEnvelope(key);
    if (!envelope) continue;
    const body = await store.getBody(key);
    const bodyText = body ? extractBodyText(body.json) : '';
    hydrated.push({
      id: hit.id,
      subject: envelope.subject ?? '(no subject)',
      text: bodyText || envelope.preview || '',
    });
  }
  return hydrated;
}

export function buildPrompt(question: string, sources: HydratedSource[]): ChatMessage[] {
  const context = sources
    .map(
      (s, i) =>
        `[${i + 1}] Subject: ${s.subject}\n${s.text.slice(0, MAX_SNIPPET_CHARS)}`,
    )
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        'You answer questions about the user\'s email using only the numbered excerpts ' +
        'below as context. Cite sources by their number in brackets, e.g. [1]. If the ' +
        "excerpts don't contain the answer, say so plainly rather than guessing.",
    },
    { role: 'user', content: `${context}\n\nQuestion: ${question}` },
  ];
}

/**
 * Single active account only (matches every other read path in this app —
 * email-store.ts's `readMailboxPage`/`readMessage` callers use the same pair).
 * Retrieval hydration deliberately skips the offline-reads.ts overlay: this
 * feeds a model, it isn't displayed, so reconciling pending local edits buys
 * nothing here.
 */
export async function askLocalMail(question: string): Promise<AskResult> {
  const settings = useSettingsStore.getState();
  const accountId = useAccountStore.getState().activeAccountId;
  const jmapAccountId = jmapClient.accountId;
  if (!accountId || !jmapAccountId) {
    throw new Error('No active account to search');
  }
  if (settings.aiActiveProvider === null) {
    throw new Error('No AI provider configured');
  }
  if (settings.aiActiveProvider === 'local' && !settings.aiLocalModel) {
    throw new Error('No local model selected');
  }
  if (settings.aiActiveProvider === 'public' && !settings.aiPublicModel) {
    throw new Error('No public model set');
  }

  const hydrated = await retrieveContext(accountId, jmapAccountId, question, settings.aiScopeDays);
  const messages = buildPrompt(question, hydrated);
  let answer: string;
  if (settings.aiActiveProvider === 'public') {
    const apiKey = await getAiApiKey('public');
    if (!apiKey) throw new Error('No public API key saved');
    answer = await chatPublic(settings.aiPublicBaseUrl, apiKey, settings.aiPublicModel, messages);
  } else {
    answer = await chatLocal(settings.aiLocalBaseUrl, settings.aiLocalModel, messages);
  }

  return {
    answer,
    sources: hydrated.map(({ id, subject }) => ({ id, subject })),
  };
}
