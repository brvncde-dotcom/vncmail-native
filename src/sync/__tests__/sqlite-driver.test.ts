// Stage A of the delta-sync build order (design §14.3 step 3.1): the empirical
// gate on "plain expo-sqlite works in Expo Go", which the design's whole
// build-order decision rests on (§9.2 V4).
//
// What this file can and cannot prove:
//
//   * It CAN prove the SQL and the API shape. `SqliteDriver` is structurally
//     satisfied by expo-sqlite's `SQLiteDatabase` (`_ExpoDatabaseIsADriver` in
//     sqlite-driver.ts, checked by `npm run typecheck`), and the statements
//     below run against real SQLite via node:sqlite.
//   * It CANNOT prove Expo Go loads the native module, because no test in this
//     environment can: expo-sqlite's node entry point
//     (`web/SQLiteModule.node.ts`) is an explicitly documented dummy — "expo-sqlite
//     is not supported on server runtime" — whose every method ignores its
//     arguments. A test importing it would pass while asserting nothing.
//
// The Expo Go answer therefore comes from packaging evidence, recorded here so a
// later reader does not have to re-derive it:
//
//   1. expo-sqlite@16.0.10 is in expo@54's `bundledNativeModules.json`, pinned
//      at the version `npx expo install` picked for this repo.
//   2. `expo-module.config.json` publishes an Android AAR under groupId
//      `host.exp.exponent` from a vendored `local-maven-repo/` — the same
//      mechanism as every Expo module this app already ships and runs in Expo Go
//      (expo-secure-store, expo-camera, expo-file-system, expo-localization,
//      expo-image-picker, expo-web-browser, expo-document-picker).
//   3. expo-sqlite is the only one of those with a
//      `shouldUsePublicationScriptPath`, and `android/shouldUsePublication.groovy`
//      reads: use the prebuilt published AAR iff NONE of
//      `expo.sqlite.{useSQLCipher,useLibSQL,enableFTS,customBuildFlags,withSQLiteVecExtension}`
//      is set. That single line is the mechanism behind the design's claim:
//      plain use consumes a prebuilt binary (no native compile, hence Expo
//      Go-able), and setting any flag — `useSQLCipher` included — switches to
//      compiling SQLite from source, which needs a real native build.
//   4. The config plugin (`plugin/src/withSQLite.ts`) is a strict no-op without
//      props: every write is gated on `value !== undefined`. Plain use needs no
//      app.config.js entry and no prebuild.
//   5. Expo's own SDK docs for v54 state expo-sqlite is "Included in Expo Go"
//      and, separately, that "SQLCipher is not supported on Expo Go".
//
// Two adjacent facts worth recording while the evidence was open:
//   * FTS5 is on by DEFAULT in both platform builds (`android/build.gradle`
//     `findProperty('expo.sqlite.enableFTS') != 'false'`; the podspec's
//     `unless podfile_properties['expo.sqlite.enableFTS'] == 'false'`), so
//     §9.4's step-9 FTS5 hook also needs no config plugin and no prebuild —
//     setting `enableFTS` explicitly would *cost* Expo Go compatibility rather
//     than buy the feature.
//   * The FTS5 assertion below is against node:sqlite, so it proves the test
//     engine has FTS5, not the device build. The device claim is the default
//     above.

import { describe, expect, it } from 'vitest';

import { openTestDriver } from './sqlite-test-driver';

describe('expo-sqlite driver surface (Stage A smoke)', () => {
  it('opens a database, creates a table, inserts and reads a row', async () => {
    const db = openTestDriver();
    try {
      await db.execAsync(`
        CREATE TABLE smoke (
          jmap_account_id TEXT NOT NULL,
          id TEXT NOT NULL,
          received_at TEXT NOT NULL,
          PRIMARY KEY (jmap_account_id, id)
        );
      `);

      const run = await db.runAsync(
        'INSERT INTO smoke (jmap_account_id, id, received_at) VALUES (?, ?, ?)',
        ['acct-a', 'E1', '2026-08-04T10:00:00Z'],
      );
      expect(run.changes).toBe(1);

      const row = await db.getFirstAsync<{ id: string; received_at: string }>(
        'SELECT id, received_at FROM smoke WHERE jmap_account_id = ? AND id = ?',
        ['acct-a', 'E1'],
      );
      expect(row).toEqual({ id: 'E1', received_at: '2026-08-04T10:00:00Z' });

      const none = await db.getFirstAsync('SELECT id FROM smoke WHERE id = ?', ['nope']);
      expect(none).toBeNull();

      const all = await db.getAllAsync<{ id: string }>('SELECT id FROM smoke', []);
      expect(all).toEqual([{ id: 'E1' }]);
    } finally {
      await db.closeAsync();
    }
  });

  it('enforces the account-scoped primary key rather than a bare id (S3)', async () => {
    const db = openTestDriver();
    try {
      await db.execAsync(`
        CREATE TABLE smoke (
          jmap_account_id TEXT NOT NULL, id TEXT NOT NULL,
          PRIMARY KEY (jmap_account_id, id)
        );
      `);
      // The same JMAP id under two accounts must coexist — the whole point of S3.
      await db.runAsync('INSERT INTO smoke VALUES (?, ?)', ['acct-a', 'E1']);
      await db.runAsync('INSERT INTO smoke VALUES (?, ?)', ['acct-b', 'E1']);
      expect(
        await db.getFirstAsync<{ c: number }>('SELECT count(*) AS c FROM smoke', []),
      ).toEqual({ c: 2 });

      // ...and a genuine duplicate must still be rejected.
      await expect(
        db.runAsync('INSERT INTO smoke VALUES (?, ?)', ['acct-a', 'E1']),
      ).rejects.toThrow();
    } finally {
      await db.closeAsync();
    }
  });

  it('runs real transactions: ROLLBACK discards, COMMIT keeps', async () => {
    const db = openTestDriver();
    try {
      await db.execAsync('CREATE TABLE t (id TEXT PRIMARY KEY)');

      await db.execAsync('BEGIN IMMEDIATE');
      await db.runAsync('INSERT INTO t VALUES (?)', ['a']);
      await db.execAsync('ROLLBACK');
      expect(await db.getAllAsync('SELECT id FROM t', [])).toEqual([]);

      await db.execAsync('BEGIN IMMEDIATE');
      await db.runAsync('INSERT INTO t VALUES (?)', ['b']);
      await db.execAsync('COMMIT');
      expect(await db.getAllAsync<{ id: string }>('SELECT id FROM t', [])).toEqual([{ id: 'b' }]);
    } finally {
      await db.closeAsync();
    }
  });

  it('has FTS5 available in the test engine (§9.4 step-9 hook)', async () => {
    const db = openTestDriver();
    try {
      await db.execAsync("CREATE VIRTUAL TABLE fts USING fts5(subject, body)");
      await db.runAsync('INSERT INTO fts (subject, body) VALUES (?, ?)', ['hello', 'world']);
      const hit = await db.getFirstAsync<{ subject: string }>(
        "SELECT subject FROM fts WHERE fts MATCH ?",
        ['hello'],
      );
      expect(hit).toEqual({ subject: 'hello' });
    } finally {
      await db.closeAsync();
    }
  });
});
