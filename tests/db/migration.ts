/**
 * Migration test: a real NeDB data file must migrate to SQLite losslessly
 * (documents, dates, tombstones, replay order, indexes) with a backup.
 *
 * Run: bun tests/db/migration.ts
 */

import nedb from '@seald-io/nedb';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteStore } from '../../src/utils/db/SqliteStore';
import { baseDocs, baseQueries, clone, label, sortDocs, Tester } from './harness';

const dir = mkdtempSync(path.join(tmpdir(), 'asphyxia-migrate-'));
const tester = new Tester('migration');

const file = path.join(dir, 'plug@test.db');
const backup = path.join(dir, '_nedb_backup', 'plug@test.db');
const originalCopy = path.join(dir, 'original.db');

// ---------------------------------------------------------------------------
// Build a realistic NeDB file: inserts, repeated updates, deletes, re-inserts.
// ---------------------------------------------------------------------------
{
  const nd = new nedb({ filename: file, timestampData: true });
  await nd.loadDatabaseAsync();

  for (const doc of baseDocs) await nd.insertAsync(clone(doc));

  // Multiple appends for the same document (NeDB is append-only).
  await nd.updateAsync({ _id: 'd1' }, { $set: { age: 30 } }, {});
  await nd.updateAsync({ _id: 'd1' }, { $inc: { score: 5 } }, {});
  await nd.updateAsync({ _id: 'd1' }, { $set: { 'nested.y.z': 42 } }, {});
  await nd.updateAsync({ _id: 'd2' }, { $push: { tags: 'z' } }, {});

  // Delete + re-insert with the same _id (tombstone then insert).
  await nd.removeAsync({ _id: 'd5' }, {});
  await nd.insertAsync({ _id: 'd5', __s: 'plugins', collection: 'misc', name: 'reborn', rank: 7 });

  await nd.ensureIndexAsync({ fieldName: 'name', unique: true, sparse: true });
}

const rawBefore = readFileSync(file);
copyFileSync(file, originalCopy);

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------
const sq = new SqliteStore(file, { timestampData: true, corruptAlertThreshold: 0 });
await sq.loadDatabaseAsync();

tester.truthy('file is now SQLite', readFileSync(file).subarray(0, 15).toString() === 'SQLite format 3');
tester.truthy('backup exists', existsSync(backup));
tester.truthy('backup is byte-identical', readFileSync(backup).equals(rawBefore));

// Reference NeDB state from the untouched copy.
const ref = new nedb({ filename: originalCopy, timestampData: true });
await ref.loadDatabaseAsync();

const allRef = await ref.findAsync({}).execAsync();
const allSq = await sq.findAsync({}).execAsync();
tester.equal('migrated state', sortDocs(allRef), sortDocs(allSq));

for (const query of baseQueries) {
  const name = label(query).slice(0, 80);
  const a = await ref.findAsync(query).execAsync();
  const b = await sq.findAsync(query).execAsync();
  tester.equal(`find ${name}`, sortDocs(a), sortDocs(b));
  tester.equal(`count ${name}`, await ref.countAsync(query), await sq.countAsync(query));
}

// Timestamps survived as real Dates.
const d1: any = await sq.findOneAsync({ _id: 'd1' });
tester.truthy('createdAt revived as Date', d1.createdAt instanceof Date);
tester.truthy('updatedAt revived as Date', d1.updatedAt instanceof Date);

// ---------------------------------------------------------------------------
// Re-open the migrated file (no second migration) and compare
// ---------------------------------------------------------------------------
{
  const again = new SqliteStore(file, { timestampData: true, corruptAlertThreshold: 0 });
  await again.loadDatabaseAsync();
  const state = await again.findAsync({}).execAsync();
  tester.equal('state after reopen', sortDocs(state), sortDocs(allSq));
  again.close();
}

// ---------------------------------------------------------------------------
// Indexes declared in the NeDB file carried over
// ---------------------------------------------------------------------------
{
  const insert = async (doc: any) => {
    try {
      await sq.insertAsync(doc);
      return null;
    } catch (err: any) {
      return err?.message ?? String(err);
    }
  };
  const duplicate = await insert({ _id: 'u1', name: 'alice' });
  tester.truthy('migrated unique index enforced', duplicate);

  const sparseOk = await insert({ _id: 'u2', other: 1 });
  tester.equal('migrated sparse index allows missing', sparseOk, null);
}

// ---------------------------------------------------------------------------
// Corruption handling
// ---------------------------------------------------------------------------
{
  const valid = Array.from({ length: 9 }, (_, i) => JSON.stringify({ _id: `v${i}`, collection: 'x', n: i }));
  const content = [...valid, '{ this is not json'].join('\n') + '\n';
  // 10 lines, 1 corrupt => 10%

  const strictFile = path.join(dir, 'corrupt-strict.db');
  writeFileSync(strictFile, content);
  const strict = new SqliteStore(strictFile, { corruptAlertThreshold: 0 });
  let error: any = null;
  try {
    await strict.loadDatabaseAsync();
  } catch (err) {
    error = err;
  }
  tester.truthy('strict threshold rejects corrupt file', error);
  tester.truthy('corruption error message', /corrupt/i.test(error?.message ?? ''));
  tester.equal('corrupt file left untouched', readFileSync(strictFile, 'utf8'), content);

  const laxFile = path.join(dir, 'corrupt-lax.db');
  writeFileSync(laxFile, content);
  const lax = new SqliteStore(laxFile, { corruptAlertThreshold: 0.2 });
  await lax.loadDatabaseAsync();
  tester.equal('lax threshold loads valid docs', await lax.countAllAsync(), 9);
}

// ---------------------------------------------------------------------------
// CRLF / no trailing newline files
// ---------------------------------------------------------------------------
{
  const crlfFile = path.join(dir, 'crlf.db');
  writeFileSync(crlfFile, [JSON.stringify({ _id: 'c1', v: 1 }), JSON.stringify({ _id: 'c2', v: 2 })].join('\r\n'));
  const store = new SqliteStore(crlfFile, { corruptAlertThreshold: 0 });
  await store.loadDatabaseAsync();
  tester.equal('CRLF file migrated', await store.countAllAsync(), 2);
}

rmSync(dir, { recursive: true, force: true });
const failures = tester.report();
if (failures > 0) process.exitCode = 1;
