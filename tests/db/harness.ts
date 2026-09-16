/**
 * Shared helpers for the SQLite store tests.
 */

export interface CanonOptions {
  knownIds?: Set<string>;
}

export const canon = (value: any, opts: CanonOptions = {}, key?: string): any => {
  if (value === undefined) return { $undefined: true };
  if (value instanceof Date) return { $date: value.getTime() };
  if (value instanceof RegExp) return { $regex: value.source, $flags: value.flags };
  if (Array.isArray(value)) return value.map(v => canon(v, opts));
  if (value !== null && typeof value === 'object') {
    const out: any = {};
    // Sorted keys make comparisons key-order insensitive.
    for (const k of Object.keys(value).sort()) out[k] = canon(value[k], opts, k);
    return out;
  }
  if (key === '_id' && typeof value === 'string' && opts.knownIds && !opts.knownIds.has(value)) return '<generated>';
  return value;
};

export const show = (value: any, opts: CanonOptions = {}): string => JSON.stringify(canon(value, opts));

export const label = (value: any): string =>
  JSON.stringify(canon(value), (_k, v) => (typeof v === 'function' ? `[fn ${v.toString()}]` : v));

export const clone = (value: any): any => {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (Array.isArray(value)) return value.map(clone);
  const out: any = {};
  for (const k of Object.keys(value)) out[k] = clone(value[k]);
  return out;
};

/** Stable sort of query results for comparison (generated ids must not affect order). */
export const sortDocs = (docs: any[], opts: CanonOptions = {}): any[] =>
  [...docs].sort((a, b) => (show(a, opts) < show(b, opts) ? -1 : show(a, opts) > show(b, opts) ? 1 : 0));

export class Tester {
  failures = 0;
  checks = 0;
  private label: string;

  constructor(label: string) {
    this.label = label;
  }

  equal(name: string, actual: any, expected: any, opts: CanonOptions = {}): void {
    this.checks += 1;
    const a = show(actual, opts);
    const b = show(expected, opts);
    if (a !== b) {
      this.failures += 1;
      console.error(`FAIL [${this.label}] ${name}\n  actual:   ${a}\n  expected: ${b}`);
    }
  }

  truthy(name: string, value: any): void {
    this.checks += 1;
    if (!value) {
      this.failures += 1;
      console.error(`FAIL [${this.label}] ${name} (expected truthy, got ${show(value)})`);
    }
  }

  report(): number {
    if (this.failures > 0) console.error(`[${this.label}] ${this.failures}/${this.checks} checks FAILED`);
    else console.log(`[${this.label}] all ${this.checks} checks passed`);
    return this.failures;
  }
}

/** Documents shared by the differential and migration tests. */
export const baseDocs: any[] = [
  {
    _id: 'd1',
    __s: 'plugins_profile',
    __refid: 'user1',
    collection: 'profile',
    name: 'alice',
    age: 30,
    active: true,
    tags: ['a', 'b'],
    nested: { x: 1, y: { z: 2 } },
    score: 100,
  },
  {
    _id: 'd2',
    __s: 'plugins_profile',
    __refid: 'user1',
    collection: 'profile',
    name: 'bob',
    age: 25,
    active: false,
    tags: [],
    nested: { x: 2 },
    score: 50,
    extra: null,
  },
  {
    _id: 'd3',
    __s: 'plugins_profile',
    __refid: 'user2',
    collection: 'score',
    music_id: 1,
    score: 900,
    flags: [{ t: 1 }, { t: 2 }],
  },
  {
    _id: 'd4',
    __s: 'plugins_profile',
    __refid: 'user2',
    collection: 'score',
    music_id: 2,
    score: 1500,
    tags: ['x'],
    date: new Date(1700000000000),
  },
  { _id: 'd5', __s: 'plugins', collection: 'misc', name: 'global', rank: 3 },
];

export const baseIds = new Set(baseDocs.map(d => d._id));

export const baseQueries: any[] = [
  {},
  { __refid: 'user1' },
  { __s: 'plugins' },
  { __s: 'plugins_profile', score: { $gte: 100 } },
  { __refid: { $in: ['user1', 'user2'] } },
  { __refid: { $exists: true } },
  { collection: 'profile' },
  { age: 30 },
  { age: { $gt: 26 } },
  { age: { $gte: 25, $lt: 30 } },
  { active: true },
  { active: false },
  { extra: null },
  { missing: null },
  { tags: 'a' },
  { tags: { $size: 2 } },
  { tags: { $in: ['x', 'z'] } },
  { name: { $in: ['alice', 'bob'] } },
  { name: { $nin: ['alice'] } },
  { name: { $ne: 'alice' } },
  { name: { $regex: /^a/ } },
  { name: { $exists: true } },
  { extra: { $exists: false } },
  { 'nested.x': 1 },
  { 'nested.y.z': 2 },
  { 'flags.t': 2 },
  { score: 900 },
  { score: { $lte: 900 } },
  { score: { $ne: 900 } },
  { date: { $lt: new Date(1700000000001) } },
  { date: { $gte: new Date(1700000000000) } },
  { $or: [{ age: 30 }, { music_id: 2 }] },
  { $and: [{ collection: 'score' }, { score: { $gte: 1000 } }] },
  { $not: { collection: 'profile' } },
  { $where: function (this: any) { return this.age > 26; } },
  { collection: { $in: ['profile', 'misc'] }, age: { $exists: true } },
  { flags: { $elemMatch: { t: 1 } } },
  { collection: 'score', score: { $ne: 900 } },
  { collection: 'profile', tags: { $size: 0 } },
];
