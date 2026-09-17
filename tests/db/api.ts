/**
 * Plugin-facing index API test: DB.EnsureIndex / DB.RemoveIndex through the
 * EamuseIO entry points used by ExternalPluginLoader.
 *
 * Run: bun tests/db/api.ts
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Database } from 'bun:sqlite';
import { Tester } from './harness';

const dir = mkdtempSync(path.join(tmpdir(), 'asphyxia-api-'));
const prevCwd = process.cwd();
// EamuseIO derives EXEC_PATH/SAVE_PATH from the cwd at import time.
process.chdir(dir);

const { APIEnsureIndex, APIRemoveIndex, APIInsert, APIFind } = await import('../../src/utils/EamuseIO');

const tester = new Tester('api');
const plugin = { identifier: 'apitest', core: false };

const attempt = async (fn: () => Promise<any>): Promise<{ ok?: any; error?: string }> => {
  try {
    return { ok: await fn() };
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
};

// Idempotent declaration, unique + sparse.
tester.equal('EnsureIndex resolves', await attempt(() => APIEnsureIndex(plugin, { fieldName: 'probe', unique: true, sparse: true })), { ok: undefined });
tester.equal('EnsureIndex idempotent', await attempt(() => APIEnsureIndex(plugin, { fieldName: 'probe', unique: true, sparse: true })), { ok: undefined });

const first = await attempt(() => APIInsert(plugin, { collection: 'x', probe: 'one' }));
tester.truthy('first insert ok', first.ok?._id);
tester.truthy('duplicate rejected', (await attempt(() => APIInsert(plugin, { collection: 'x', probe: 'one' }))).error);
tester.equal(
  'sparse allows missing values',
  [(await attempt(() => APIInsert(plugin, { collection: 'x', other: 1 }))).error ?? null, (await attempt(() => APIInsert(plugin, { collection: 'x', other: 2 }))).error ?? null],
  [null, null]
);

// The index exists in SQLite.
const db = new Database(path.join(dir, 'savedata', 'apitest.db'));
const indexCount = () => (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_nd_%'").all() as any[]).length;
tester.equal('sqlite index created', indexCount(), 1);

// Removal drops the constraint and the SQLite index.
tester.equal('RemoveIndex resolves', await attempt(() => APIRemoveIndex(plugin, 'probe')), { ok: undefined });
tester.equal('duplicate allowed after RemoveIndex', (await attempt(() => APIInsert(plugin, { collection: 'x', probe: 'one' }))).error ?? null, null);
tester.equal('sqlite index dropped', indexCount(), 0);
tester.equal('RemoveIndex missing is a no-op', await attempt(() => APIRemoveIndex(plugin, 'never_existed')), { ok: undefined });

// Validation.
tester.truthy('rejects __ fields', (await attempt(() => APIEnsureIndex(plugin, { fieldName: '__s' }))).error);
tester.truthy('rejects missing fieldName', (await attempt(() => APIEnsureIndex(plugin, {}))).error);
tester.truthy('rejects bad unique type', (await attempt(() => APIEnsureIndex(plugin, { fieldName: 'ok', unique: 'yes' }))).error);
tester.truthy('RemoveIndex rejects __ fields', (await attempt(() => APIRemoveIndex(plugin, '__refid'))).error);

// Queries unaffected.
const found = (await APIFind(plugin, { collection: 'x' })) as any[];
tester.equal('stored documents queryable', found.length >= 4, true);

db.close();
process.chdir(prevCwd);
rmSync(dir, { recursive: true, force: true });

const failures = tester.report();
if (failures > 0) process.exitCode = 1;
