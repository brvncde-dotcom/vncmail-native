// The narrow SQL surface the sync store needs, and nothing more.
//
// Why a seam at all, when §9.1 says the engine talks only to `SyncStore`: the
// engine still does. This interface sits *below* `SyncStore`, inside the
// `store-sqlite.ts` backend, and exists so the storage contract tests can run
// the real §9.3 schema and the real SQL against a real SQLite engine in
// `vitest` (node:sqlite) instead of against a hand-rolled fake. expo-sqlite's
// own node build (`web/SQLiteModule.node.ts`) is a documented no-op stub — every
// method resolves to a value that ignores its arguments — so importing it in a
// node test would assert nothing at all.
//
// `SQLiteDatabase` from expo-sqlite satisfies this interface structurally; the
// `_ExpoDatabaseIsADriver` assertion below is what keeps that true as
// expo-sqlite's API moves. No adapter object, no wrapper cost in production.

import type { SQLiteDatabase } from 'expo-sqlite';

/** Mirrors expo-sqlite's `SQLiteBindValue`. */
export type SqlValue = string | number | null | boolean | Uint8Array;

/** Positional (`?`) parameters only. The store never uses named parameters. */
export type SqlParams = SqlValue[];

export interface SqlRunResult {
  lastInsertRowId: number;
  changes: number;
}

export interface SqliteDriver {
  /** Multi-statement DDL, plus the explicit BEGIN/COMMIT/ROLLBACK of §9.2. */
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SqlParams): Promise<SqlRunResult>;
  getAllAsync<T>(source: string, params: SqlParams): Promise<T[]>;
  getFirstAsync<T>(source: string, params: SqlParams): Promise<T | null>;
  closeAsync(): Promise<void>;
}

/**
 * Compile-time proof that expo-sqlite's `SQLiteDatabase` is usable as a
 * `SqliteDriver` with no adapter. Emits nothing; fails `npm run typecheck` if
 * expo-sqlite's surface drifts away from what the store depends on.
 */
type AssertAssignable<Target, Source extends Target> = Source;
export type _ExpoDatabaseIsADriver = AssertAssignable<SqliteDriver, SQLiteDatabase>;

/**
 * Opens the account's database through expo-sqlite.
 *
 * The import is dynamic on purpose: `expo-sqlite`'s entry point calls
 * `requireNativeModule('ExpoSQLite')` at module scope, which throws outside a
 * React Native runtime. A static import would make every test that touches the
 * store — including the pure ones — unloadable in node.
 *
 * Plain expo-sqlite only. `useSQLCipher` is a native build flag (§14.3 step
 * 3.7), set through the config plugin, not an argument here.
 */
export async function openExpoSqliteDriver(databaseName: string): Promise<SqliteDriver> {
  const { openDatabaseAsync } = await import('expo-sqlite');
  return openDatabaseAsync(databaseName);
}
