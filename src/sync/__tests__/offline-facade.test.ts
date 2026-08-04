// The bug this file exists for: `OfflineCacheBanner` branched on the v2 flag and its
// sibling `AboutDataSettings` did not, so with 761 real envelopes on disk the Settings
// screen said "Nothing cached yet", "Sync now" ran the v1 bulk downloader, and "Clear
// offline mail" would have cleared the wrong store. Found only by running the app.
//
// The fix is not "add the branch to the second screen" — that leaves a third site free to
// diverge the same way. Every consumer now goes through ONE facade, and the last test here
// enforces that there is only one branch point.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearOfflineMail,
  offlineEngineActive,
  offlineStats,
  syncNow,
  type OfflineFacadeDeps,
} from '../offline-facade';
import { SyncRegistry } from '../registry';
import { SqliteStoreFactory } from '../store-sqlite';
import { FakeJmapServer } from './fake-jmap';
import { createTestHost } from './sqlite-test-driver';

const ACCOUNT = 'alice@mail.example';
const T0 = Date.parse('2026-08-04T00:00:00.000Z');

let host: ReturnType<typeof createTestHost>;
let factory: SqliteStoreFactory;
let server: FakeJmapServer;
let ranV1: number;
let firedTriggers: string[];
let v1Cleared: number;

function makeDeps(over: Partial<OfflineFacadeDeps> = {}): OfflineFacadeDeps {
  return {
    factory,
    engineEnabled: () => true,
    cacheEnabled: () => true,
    localAccountId: () => ACCOUNT,
    jmapAccountId: () => server.accountId,
    fireTrigger: (reason) => {
      firedTriggers.push(reason);
      return true;
    },
    runV1Sync: async () => {
      ranV1 += 1;
    },
    v1Stats: () => ({ count: 3, bytes: 300 }),
    clearV1: async () => {
      v1Cleared += 1;
    },
    ...over,
  };
}

async function seedEngineStore(envelopes: number, bodies: number): Promise<void> {
  const store = await factory.open(ACCOUNT);
  await store.transaction(async (txn) => {
    for (let i = 0; i < envelopes; i += 1) {
      await txn.upsertEnvelopes([
        {
          jmapAccountId: server.accountId,
          id: `E${i}`,
          threadId: null,
          receivedAt: new Date(T0 - i * 1000).toISOString(),
          size: 100,
          subject: `s${i}`,
          preview: null,
          from: null,
          to: null,
          cc: null,
          hasAttachment: false,
          keywords: {},
          mailboxIds: { inbox: true },
          hasBody: false,
          bodyBytes: 0,
          cachedAt: T0,
        },
      ]);
    }
    for (let i = 0; i < bodies; i += 1) {
      await txn.putBodyIfEnvelopeExists(
        { jmapAccountId: server.accountId, id: `E${i}` },
        {
          jmapAccountId: server.accountId,
          emailId: `E${i}`,
          receivedAt: new Date(T0 - i * 1000).toISOString(),
          json: '{"x":1}',
          bytes: 1000,
        },
      );
    }
  });
}

beforeEach(async () => {
  await AsyncStorage.clear();
  vi.clearAllMocks();
  host = createTestHost();
  factory = new SqliteStoreFactory(host, new SyncRegistry());
  server = new FakeJmapServer();
  ranV1 = 0;
  firedTriggers = [];
  v1Cleared = 0;
});

afterEach(() => host.cleanup());

describe('"Sync now" hits the engine that is actually running', () => {
  it('fires the v2 manual trigger and does NOT run the v1 downloader', async () => {
    // The reported bug: `handleSyncNow` called `runOfflineSync` unconditionally, so the
    // press did nothing to the v2 engine — and, worse, kicked off a v1 bulk download
    // underneath it, which is what made "Last sync just now" update while the SQLite file
    // was untouched.
    const result = await syncNow(makeDeps());
    expect(result).toBe('v2');
    // T3: user-initiated, never throttled (§10.1).
    expect(firedTriggers).toEqual(['manual']);
    expect(ranV1).toBe(0);
  });

  it('runs the v1 downloader when the flag is off, and never touches the engine', async () => {
    const result = await syncNow(makeDeps({ engineEnabled: () => false }));
    expect(result).toBe('v1');
    expect(ranV1).toBe(1);
    expect(firedTriggers).toEqual([]);
  });

  it('reports unavailable when the engine is on but not yet wired', async () => {
    // Flag on but no live session, so `startSyncEngine()` has not run. Silently falling
    // back to v1 here would be the original bug wearing a disguise: two engines writing
    // an offline copy of the same mail from different cursors (§14.2).
    const result = await syncNow(makeDeps({ fireTrigger: () => false }));
    expect(result).toBe('unavailable');
    expect(ranV1).toBe(0);
  });

  it('does nothing when offline caching itself is off', async () => {
    const result = await syncNow(makeDeps({ cacheEnabled: () => false }));
    expect(result).toBe('unavailable');
    expect(ranV1).toBe(0);
    expect(firedTriggers).toEqual([]);
  });
});

describe('the displayed stats come from the store that holds the mail', () => {
  it('counts envelopes and body bytes from the v2 store', async () => {
    await seedEngineStore(12, 4);
    const stats = await offlineStats(makeDeps());
    expect(stats.source).toBe('v2');
    // The reported symptom was "Nothing cached yet" with 761 envelopes on disk.
    expect(stats.count).toBe(12);
    expect(stats.bytes).toBe(4000);
  });

  it('falls back to the v1 store when the flag is off', async () => {
    await seedEngineStore(12, 4);
    const stats = await offlineStats(makeDeps({ engineEnabled: () => false }));
    expect(stats.source).toBe('v1');
    expect(stats.count).toBe(3);
    expect(stats.bytes).toBe(300);
  });

  it('reports zero for a v2 account that has never synced, without materialising (§9.5)', async () => {
    const stats = await offlineStats(makeDeps());
    expect(stats).toEqual({ count: 0, bytes: 0, source: 'v2' });
    expect(await factory.isMaterialised(ACCOUNT)).toBe(false);
  });
});

describe('"Clear offline mail" clears the store that holds the mail', () => {
  it('clears v2 records and marks a resync, keeping the cursors (§7.5 rule 7)', async () => {
    await seedEngineStore(5, 2);
    const target = await clearOfflineMail(makeDeps());
    expect(target).toBe('v2');

    const store = await factory.open(ACCOUNT);
    expect(await store.countEnvelopes()).toBe(0);
    expect(await store.bodyBytesTotal()).toBe(0);
    // clearRecords wipes records + the body queue and sets resyncRequired; nulling the
    // cursor instead would leave the engine unable to tell what it still needs.
    expect((await store.loadAccountState()).resyncRequired).toBe(true);
    expect(v1Cleared).toBe(0);
  });

  it('clears the v1 cache when the flag is off', async () => {
    await seedEngineStore(5, 2);
    const target = await clearOfflineMail(makeDeps({ engineEnabled: () => false }));
    expect(target).toBe('v1');
    expect(v1Cleared).toBe(1);
    // The v2 store is left alone — it is not the active one.
    expect(await (await factory.open(ACCOUNT)).countEnvelopes()).toBe(5);
  });
});

describe('offlineEngineActive is the single branch point', () => {
  it('requires both the flag and offline caching', () => {
    expect(offlineEngineActive(makeDeps())).toBe(true);
    expect(offlineEngineActive(makeDeps({ engineEnabled: () => false }))).toBe(false);
    expect(offlineEngineActive(makeDeps({ cacheEnabled: () => false }))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The generalised guard — "is there a third site?"
// ─────────────────────────────────────────────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__') continue;
      sourceFiles(path, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function codeLines(text: string): Array<{ line: string; number: number }> {
  const out: Array<{ line: string; number: number }> = [];
  let inBlock = false;
  text.split('\n').forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    const start = line.indexOf('/*');
    if (start !== -1) {
      const end = line.indexOf('*/', start + 2);
      if (end === -1) {
        inBlock = true;
        line = line.slice(0, start);
      } else {
        line = line.slice(0, start) + line.slice(end + 2);
      }
    }
    const lc = line.indexOf('//');
    if (lc !== -1) line = line.slice(0, lc);
    if (line.trim()) out.push({ line, number: i + 1 });
  });
  return out;
}

describe('every offline-mail consumer branches in exactly one place', () => {
  const SRC = join(__dirname, '..', '..');
  const APP = join(__dirname, '..', '..', '..', 'App.tsx');

  // The facade is the branch point. `offline-sync.ts` IS v1. `offline-cache-store.ts` is
  // v1's store. `email-store` still write-throughs to v1 for the v1 path and gates it
  // internally (asserted separately below).
  const ALLOWED_V1_READERS = [
    join('sync', 'offline-facade.ts'),
    join('sync', 'offline-hooks.ts'),
    join('lib', 'offline-sync.ts'),
    join('stores', 'offline-cache-store.ts'),
    join('stores', 'email-store.ts'),
  ];

  it('no component reads the v1 cache store directly', () => {
    // This is the assertion that would have caught the reported bug: AboutDataSettings was
    // reading `useOfflineCacheStore` for its counts while the mail lived in SQLite.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (ALLOWED_V1_READERS.some((a) => file.endsWith(a))) continue;
      for (const { line, number } of codeLines(readFileSync(file, 'utf8'))) {
        if (/useOfflineCacheStore/.test(line)) offenders.push(`${file}:${number}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing outside App.tsx and the facade calls the v1 downloader', () => {
    // App.tsx keeps its own call because §14.2's flag gates trigger REGISTRATION there —
    // that effect is the v1 path's entry point and is already gated on !engineV2.
    const offenders: string[] = [];
    for (const file of [...sourceFiles(SRC), APP]) {
      if (file.endsWith(join('sync', 'offline-facade.ts'))) continue;
      if (file.endsWith(join('lib', 'offline-sync.ts'))) continue;
      if (file === APP) continue;
      for (const { line, number } of codeLines(readFileSync(file, 'utf8'))) {
        if (/\brunOfflineSync\s*\(/.test(line)) offenders.push(`${file}:${number}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('App.tsx gates its v1 sync on the flag', () => {
    const src = readFileSync(APP, 'utf8');
    const call = src.indexOf('runOfflineSync({');
    expect(call).toBeGreaterThan(0);
    // The guard must be in the same effect, above the call.
    const effectStart = src.lastIndexOf('React.useEffect', call);
    expect(src.slice(effectStart, call)).toMatch(/if \(offlineSyncEngineV2\) return;/);
  });
});

describe('email-store stops writing to the v1 cache once the engine owns the store', () => {
  it('gates every v1 write-through on the shared predicate', () => {
    // The fourth un-branched site. §12.3 says the overlay's arrival deletes these
    // write-throughs; §14.2 keeps the v1 path alive behind the flag, so they are gated
    // instead. Ungated, the engine and the v1 cache both grow an on-device copy of the same
    // mail and only one of them is ever read.
    const src = readFileSync(join(__dirname, '..', '..', 'stores', 'email-store.ts'), 'utf8');
    const lines = src.split('\n');
    const writes = ['.patch(id, changes)', '.remove(ids)', 'await cache.put(fresh, size)'];
    for (const write of writes) {
      const at = lines.findIndex((l) => l.includes(write));
      expect(at, `no v1 write found for ${write}`).toBeGreaterThan(0);
      // The guard must be within a few lines above the write.
      const window = lines.slice(Math.max(0, at - 6), at).join('\n');
      expect(window, `${write} is not gated`).toMatch(/offlineEngineOwnsStore\(\)/);
    }
  });
});
