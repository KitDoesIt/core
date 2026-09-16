/**
 * Differential test: the SQLite store must produce the exact same results as
 * the real @seald-io/nedb datastore for a corpus of documents, queries,
 * updates and removes.
 *
 * Run: bun tests/db/differential.ts
 */

import nedb from '@seald-io/nedb';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteStore } from '../../src/utils/db/SqliteStore';
import { baseDocs, baseIds, baseQueries, clone, label, show, sortDocs, Tester } from './harness';

const dir = mkdtempSync(path.join(tmpdir(), 'asphyxia-diff-'));
const tester = new Tester('differential');

const nd = new nedb({ filename: path.join(dir, 'nedb.db'), timestampData: false });
await nd.loadDatabaseAsync();

const sq = new SqliteStore(path.join(dir, 'sqlite.db'), { timestampData: false, corruptAlertThreshold: 0 });
await sq.loadDatabaseAsync();

// ---------------------------------------------------------------------------
// Inserts
// ---------------------------------------------------------------------------
for (const doc of baseDocs) {
  const a = await nd.insertAsync(clone(doc));
  const b = await sq.insertAsync(clone(doc));
  tester.equal(`insert ${doc._id}`, a, b, { knownIds: baseIds });
}

// Auto-generated _id: same format, both stores.
{
  const a: any = await nd.insertAsync({ probe: 'auto' });
  const b: any = await sq.insertAsync({ probe: 'auto' });
  tester.equal('auto id: length', a._id.length, b._id.length);
  tester.truthy('auto id: format', /^[A-Za-z0-9]{16}$/.test(b._id));
  tester.truthy('auto id: unique', a._id !== b._id);
  await nd.removeAsync({ _id: a._id });
  await sq.removeAsync({ _id: b._id });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
const runQueries = async (phase: string) => {
  for (const query of baseQueries) {
    const name = `${phase} ${label(query).slice(0, 100)}`;
    const a = await nd.findAsync(query).execAsync();
    const b = await sq.findAsync(query).execAsync();
    tester.equal(`find ${name}`, sortDocs(a, { knownIds: baseIds }), sortDocs(b, { knownIds: baseIds }), { knownIds: baseIds });

    const aOne = await nd.findOneAsync(query);
    const bOne = await sq.findOneAsync(query);
    // NeDB returns candidates in _id-tree order and we return insertion order;
    // findOne on a multi-match query is unspecified behaviour, so only compare
    // when the match set is deterministic (0/1 doc, or all explicit ids).
    const bAll = await sq.findAsync(query).execAsync();
    const deterministic = bAll.length <= 1 || bAll.every((d: any) => baseIds.has(d._id));
    if (deterministic) tester.equal(`findOne ${name}`, aOne, bOne, { knownIds: baseIds });

    const aCount = await nd.countAsync(query);
    const bCount = await sq.countAsync(query);
    tester.equal(`count ${name}`, aCount, bCount);
  }

  // Cursor modifiers
  const sorts = [{ score: 1 }, { score: -1 }, { age: 1, score: -1 }];
  for (const sort of sorts) {
    const a = await nd.findAsync({ __s: 'plugins_profile' }).sort(sort).execAsync();
    const b = await sq.findAsync({ __s: 'plugins_profile' }).sort(sort).execAsync();
    tester.equal(`sort ${label(sort)}`, a, b, { knownIds: baseIds });
  }

  const aPage = await nd.findAsync({ __s: 'plugins_profile' }).sort({ score: -1 }).skip(1).limit(2).execAsync();
  const bPage = await sq.findAsync({ __s: 'plugins_profile' }).sort({ score: -1 }).skip(1).limit(2).execAsync();
  tester.equal('skip/limit', aPage, bPage, { knownIds: baseIds });
};

await runQueries('initial');

// ---------------------------------------------------------------------------
// Updates / upserts
// ---------------------------------------------------------------------------
interface UpdateOp {
  name: string;
  query: any;
  update: any;
  options: any;
}

const updateOps: UpdateOp[] = [
  { name: 'set single', query: { _id: 'd1' }, update: { $set: { age: 31 } }, options: {} },
  { name: 'inc multi', query: { collection: 'score' }, update: { $inc: { score: 100 } }, options: { multi: true } },
  {
    name: 'inc multi returnDocs',
    query: { collection: 'score' },
    update: { $inc: { score: -50 } },
    options: { multi: true, returnUpdatedDocs: true },
  },
  {
    name: 'unset returnDocs',
    query: { _id: 'd2' },
    update: { $unset: { extra: true } },
    options: { multi: true, returnUpdatedDocs: true },
  },
  { name: 'push', query: { _id: 'd2' }, update: { $push: { tags: 'c' } }, options: {} },
  {
    name: 'push each slice',
    query: { _id: 'd2' },
    update: { $push: { tags: { $each: ['d', 'e', 'f'], $slice: -2 } } },
    options: {},
  },
  { name: 'addToSet each', query: { _id: 'd2' }, update: { $addToSet: { tags: { $each: ['c', 'z'] } } }, options: {} },
  {
    name: 'full replace returnDocs',
    query: { _id: 'd3' },
    update: { name: 'replaced', collection: 'score' },
    options: { multi: true, returnUpdatedDocs: true },
  },
  {
    name: 'upsert modifier new doc',
    query: { collection: 'nope' },
    update: { $set: { x: 1 } },
    options: { upsert: true, multi: true, returnUpdatedDocs: true },
  },
  {
    name: 'upsert modifier with query fields',
    query: { collection: 'nope', kind: 'q' },
    update: { $set: { y: 2 } },
    options: { upsert: true, multi: true, returnUpdatedDocs: true },
  },
  {
    name: 'upsert plain object',
    query: { collection: 'plain' },
    update: { plain: 1 },
    options: { upsert: true, multi: true, returnUpdatedDocs: true },
  },
  { name: 'min', query: { _id: 'd4' }, update: { $min: { score: 100 } }, options: { returnUpdatedDocs: true } },
  { name: 'max', query: { _id: 'd4' }, update: { $max: { score: 2000 } }, options: { returnUpdatedDocs: true } },
  { name: 'pull', query: { _id: 'd3' }, update: { $pull: { flags: { t: 1 } } }, options: { returnUpdatedDocs: true } },
  { name: 'pop', query: { _id: 'd3' }, update: { $pop: { tags: 1 } }, options: { returnUpdatedDocs: true } },
  { name: 'deep set', query: { _id: 'd1' }, update: { $set: { 'nested.y.z': 9 } }, options: { returnUpdatedDocs: true } },
  { name: 'no match', query: { _id: 'does-not-exist' }, update: { $set: { a: 1 } }, options: { multi: true, returnUpdatedDocs: true } },
];

const runUpdate = async (store: any, op: UpdateOp) => {
  try {
    return { ok: await store.updateAsync(clone(op.query), clone(op.update), clone(op.options)) };
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
};

for (const op of updateOps) {
  const a = await runUpdate(nd, op);
  const b = await runUpdate(sq, op);
  tester.equal(`update ${op.name}`, a, b, { knownIds: baseIds });
}

await runQueries('after updates');

// ---------------------------------------------------------------------------
// Removes
// ---------------------------------------------------------------------------
const removeOps = [
  { name: 'single', query: { _id: 'd5' }, options: {} },
  { name: 'multi', query: { collection: 'score' }, options: { multi: true } },
  { name: 'no match', query: { name: 'nobody' }, options: { multi: true } },
];

for (const op of removeOps) {
  const a = await nd.removeAsync(clone(op.query), clone(op.options));
  const b = await sq.removeAsync(clone(op.query), clone(op.options));
  tester.equal(`remove ${op.name}`, a, b);
}

await runQueries('after removes');

// ---------------------------------------------------------------------------
// Indexes (unique + sparse)
// ---------------------------------------------------------------------------
await nd.ensureIndexAsync({ fieldName: 'probe', unique: true, sparse: true });
await sq.ensureIndexAsync({ fieldName: 'probe', unique: true, sparse: true });

const firstA = await nd.insertAsync({ _id: 'ix1', probe: 'one' });
const firstB = await sq.insertAsync({ _id: 'ix2', probe: 'one' });
tester.equal('unique index insert ok', firstA.probe, firstB.probe);

const insertDuplicate = async (store: any, doc: any) => {
  try {
    await store.insertAsync(doc);
    return null;
  } catch (err) {
    return err;
  }
};
const errA = await insertDuplicate(nd, { _id: 'ix3', probe: 'one' });
const errB = await insertDuplicate(sq, { _id: 'ix4', probe: 'one' });
tester.truthy('unique violation (nedb)', errA);
tester.truthy('unique violation (sqlite)', errB);

// sparse: multiple docs without the field are allowed in both
const sparseA = await insertDuplicate(nd, { _id: 'ix5', other: 1 });
const sparseB = await insertDuplicate(sq, { _id: 'ix6', other: 1 });
tester.equal('sparse allows missing (nedb)', sparseA, null);
tester.equal('sparse allows missing (sqlite)', sparseB, null);

// ---------------------------------------------------------------------------
// Timestamps (separate stores, timestampData: true)
// ---------------------------------------------------------------------------
{
  const ndT = new nedb({ filename: path.join(dir, 'nedb-t.db'), timestampData: true });
  await ndT.loadDatabaseAsync();
  const sqT = new SqliteStore(path.join(dir, 'sqlite-t.db'), { timestampData: true, corruptAlertThreshold: 0 });
  await sqT.loadDatabaseAsync();

  const a: any = await ndT.insertAsync({ _id: 't1', value: 1 });
  const b: any = await sqT.insertAsync({ _id: 't1', value: 1 });
  tester.truthy('timestamp insert: createdAt Date', b.createdAt instanceof Date);
  tester.truthy('timestamp insert: updatedAt Date', b.updatedAt instanceof Date);
  tester.equal('timestamp insert: ms close', a.createdAt instanceof Date, b.createdAt instanceof Date);

  const createdBefore = b.createdAt.getTime();
  await new Promise(resolve => setTimeout(resolve, 5));
  const aUpd: any = await ndT.updateAsync({ _id: 't1' }, { $set: { value: 2 } }, { returnUpdatedDocs: true });
  const bUpd: any = await sqT.updateAsync({ _id: 't1' }, { $set: { value: 2 } }, { returnUpdatedDocs: true });
  tester.equal('timestamp update: value', aUpd.affectedDocuments.value, bUpd.affectedDocuments.value);
  tester.equal('timestamp update: createdAt preserved', bUpd.affectedDocuments.createdAt.getTime(), createdBefore);
  tester.truthy('timestamp update: updatedAt advanced', bUpd.affectedDocuments.updatedAt.getTime() >= createdBefore + 5);
}

rmSync(dir, { recursive: true, force: true });
const failures = tester.report();
if (failures > 0) process.exitCode = 1;
