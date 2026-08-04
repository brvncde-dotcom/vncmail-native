// A `SqliteDriver` backed by node's built-in SQLite, for the storage contract
// tests. Real SQLite (3.51.x, FTS5 available), real BEGIN/COMMIT/ROLLBACK, real
// primary-key and index enforcement — so a contract test that passes here has
// actually exercised the §9.3 schema rather than a fake's bookkeeping.
//
// This is a test double for the *driver*, not for `SyncStore`: `store-sqlite.ts`
// runs unmodified on top of it, which is what makes it worth having.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  SqlParams,
  SqlRunResult,
  SqliteDriver,
  SqliteHost,
  SqlValue,
} from '../sqlite-driver';

// node:sqlite rejects booleans as bind values; expo-sqlite accepts them and
// coerces. Normalise here so the store's SQL is identical on both.
function toBindValue(v: SqlValue): string | number | null | Uint8Array {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class NodeSqliteDriver implements SqliteDriver {
  private closed = false;

  constructor(private readonly db: DatabaseSync) {}

  get isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('database is closed');
  }

  async execAsync(source: string): Promise<void> {
    this.assertOpen();
    this.db.exec(source);
  }

  async runAsync(source: string, params: SqlParams): Promise<SqlRunResult> {
    this.assertOpen();
    const stmt = this.db.prepare(source);
    const res = stmt.run(...params.map(toBindValue));
    return {
      lastInsertRowId: Number(res.lastInsertRowid),
      changes: Number(res.changes),
    };
  }

  async getAllAsync<T>(source: string, params: SqlParams): Promise<T[]> {
    this.assertOpen();
    const stmt = this.db.prepare(source);
    // node:sqlite returns null-prototype objects; spread them so consumers can
    // rely on ordinary object semantics (`in`, `Object.keys`, equality checks).
    return (stmt.all(...params.map(toBindValue)) as T[]).map((r) => ({ ...r }));
  }

  async getFirstAsync<T>(source: string, params: SqlParams): Promise<T | null> {
    this.assertOpen();
    const stmt = this.db.prepare(source);
    const row = stmt.get(...params.map(toBindValue));
    return row === undefined ? null : ({ ...(row as object) } as T);
  }

  async closeAsync(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** In-memory database, discarded when the driver is closed. */
export function openTestDriver(): SqliteDriver {
  return new NodeSqliteDriver(new DatabaseSync(':memory:'));
}

/** File-backed, for the tests that need to survive a "restart" (reopen). */
export function openTestDriverAtPath(path: string): SqliteDriver {
  return new NodeSqliteDriver(new DatabaseSync(path));
}

/**
 * A `SqliteHost` over real files in a throwaway temp directory, so the contract
 * tests exercise the same open/reopen/delete lifecycle §8.4 specifies —
 * including "the purge really removed the file", which an in-memory database
 * cannot demonstrate.
 */
export function createTestHost(): SqliteHost & { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'vncmail-sync-'));
  const live = new Map<string, NodeSqliteDriver>();

  return {
    dir,
    async open(databaseName: string): Promise<SqliteDriver> {
      const existing = live.get(databaseName);
      if (existing && !existing.isClosed) return existing;
      const driver = new NodeSqliteDriver(new DatabaseSync(join(dir, databaseName)));
      live.set(databaseName, driver);
      return driver;
    },
    async delete(databaseName: string): Promise<void> {
      const existing = live.get(databaseName);
      if (existing) {
        await existing.closeAsync();
        live.delete(databaseName);
      }
      rmSync(join(dir, databaseName), { force: true });
    },
    cleanup(): void {
      for (const driver of live.values()) void driver.closeAsync();
      live.clear();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Whether the host still has a file for this database — the purge assertion. */
export function hostHasDatabase(dir: string, databaseName: string): boolean {
  return existsSync(join(dir, databaseName));
}
