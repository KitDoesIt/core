/**
 * SQLite-backed replacement for the @seald-io/nedb datastore.
 *
 * Interface compatibility is the priority: the class mirrors the subset of the
 * NeDB API the core uses (`loadDatabaseAsync`, find/findOne/count/insert/
 * update/upsert/remove, cursors with sort/skip/limit, ensure/removeIndex) and
 * evaluates documents with the ported NeDB engine in NedbCompat.ts, so query
 * and update semantics stay one to one.
 *
 * Storage layout keeps the one-file-per-plugin scheme: `savedata/<name>.db` is
 * a SQLite database. Each document is stored NeDB-serialized in `docs.doc`;
 * `_id`, `__s`, `__refid`, `createdAt`/`updatedAt` are duplicated into columns
 * for indexing. SQL is only used to narrow the candidate set (always a superset
 * of the NeDB match); the JS matcher remains authoritative.
 */

import { Database, Statement } from 'bun:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'fs';
import path from 'path';
import { Logger } from '../Logger';
import {
  checkObject,
  compareThings,
  deepCopy,
  deserialize,
  getDotValue,
  isDate,
  isRegExp,
  match,
  modify,
  serialize,
  uid,
} from './NedbCompat';
import { migrateNedbFile } from './NedbMigrator';
import {
  buildIndexSql,
  createBaseIndexes,
  createTables,
  dropIndexSql,
  indexName,
  IndexSpec,
  jsonArrayLength,
  jsonExtract,
  jsonTypeOf,
} from './SqliteSchema';

export interface StoreOptions {
  timestampData?: boolean;
  corruptAlertThreshold?: number;
}

type Bind = string | number | null;

interface SqlFilter {
  sql: string;
  params: Bind[];
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'utf8');

const isPlainObject = (value: any): boolean =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !isDate(value) && !isRegExp(value);

const jsonBind = (value: string | number | boolean): Bind => (typeof value === 'boolean' ? (value ? 1 : 0) : value);

/** Mirrors NeDB's `$exists` truthiness (`false`, `null`, `undefined`, `0` are false). */
const existsTruthy = (value: any): boolean => !!(value || value === '');

const stringOrNull = (value: any): string | null => (typeof value === 'string' ? value : value == null ? null : String(value));

const dateToMs = (value: any): number | null => {
  if (value && typeof value === 'object' && typeof value.$$date === 'number') return value.$$date;
  return isDate(value) ? value.getTime() : null;
};

const combine = (parts: SqlFilter[], op: 'AND' | 'OR'): SqlFilter => ({
  sql: parts.map(p => `(${p.sql})`).join(` ${op} `),
  params: parts.flatMap(p => p.params),
});

const scalarFilter = (column: string, value: any): SqlFilter | null => {
  if (value === null) return { sql: `${column} IS NULL`, params: [] };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return { sql: `${column} = ?`, params: [jsonBind(value)] };
  return null;
};

const columnFilter = (column: string, value: any): SqlFilter | null => {
  const scalar = scalarFilter(column, value);
  if (scalar) return scalar;
  if (!isPlainObject(value)) return null;

  const parts: SqlFilter[] = [];
  for (const op of Object.keys(value)) {
    const arg = value[op];
    if (op === '$in') {
      if (!Array.isArray(arg) || !arg.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) return null;
      if (arg.length === 0) return { sql: '0', params: [] };
      parts.push({ sql: `${column} IN (${arg.map(() => '?').join(', ')})`, params: arg.map(jsonBind) });
    } else if (op === '$exists') {
      parts.push({ sql: existsTruthy(arg) ? `${column} IS NOT NULL` : `${column} IS NULL`, params: [] });
    } else {
      return null; // unsupported operator on a real column: don't push this field
    }
  }
  return parts.length ? combine(parts, 'AND') : null;
};

const eqFilter = (field: string, expr: string, typeExpr: string, value: any): SqlFilter | null => {
  if (value === null) return { sql: `${typeExpr} = 'null'`, params: [] };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return { sql: `${expr} = ?`, params: [jsonBind(value)] };
  if (isDate(value))
    return {
      sql: `${typeExpr} = 'object' AND ${jsonTypeOf(`${field}.$$date`)} = 'integer' AND ${jsonExtract(`${field}.$$date`)} = ?`,
      params: [value.getTime()],
    };
  return null;
};

const COMPARISON_SQL: Record<string, string> = { $lt: '<', $lte: '<=', $gt: '>', $gte: '>=' };

const comparisonFilter = (field: string, expr: string, typeExpr: string, op: string, value: any): SqlFilter | null => {
  const sqlOp = COMPARISON_SQL[op];
  if (!sqlOp) return null;

  if (isDate(value))
    return {
      sql: `${typeExpr} = 'object' AND ${jsonTypeOf(`${field}.$$date`)} = 'integer' AND ${jsonExtract(`${field}.$$date`)} ${sqlOp} ?`,
      params: [value.getTime()],
    };
  if (typeof value === 'number') return { sql: `${typeExpr} IN ('integer', 'real') AND ${expr} ${sqlOp} ?`, params: [value] };
  // String comparison in SQLite (BINARY) can differ from JS for astral characters,
  // so only narrow the type here and let the JS matcher do the comparison.
  if (typeof value === 'string') return { sql: `${typeExpr} = 'text'`, params: [] };
  return null;
};

const neFilter = (field: string, expr: string, typeExpr: string, value: any): SqlFilter | null => {
  if (value === null) return { sql: `${expr} IS NOT NULL`, params: [] };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const types = typeof value === 'number' ? "'integer', 'real'" : typeof value === 'boolean' ? "'true', 'false'" : "'text'";
    return { sql: `(${expr} IS NOT ? OR ${typeExpr} NOT IN (${types}))`, params: [jsonBind(value)] };
  }
  if (isDate(value))
    return {
      sql: `(${jsonExtract(`${field}.$$date`)} IS NOT ? OR ${typeExpr} IS NOT 'object' OR ${jsonTypeOf(`${field}.$$date`)} IS NOT 'integer')`,
      params: [value.getTime()],
    };
  return null;
};

const operatorFilter = (field: string, expr: string, typeExpr: string, op: string, arg: any): SqlFilter | null => {
  switch (op) {
    case '$in': {
      if (!Array.isArray(arg) || !arg.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
        return null;
      if (arg.length === 0) return { sql: '0', params: [] };
      return { sql: `${expr} IN (${arg.map(() => '?').join(', ')})`, params: arg.map(jsonBind) };
    }
    case '$exists':
      return { sql: existsTruthy(arg) ? `${typeExpr} IS NOT NULL` : `${typeExpr} IS NULL`, params: [] };
    case '$ne':
      return neFilter(field, expr, typeExpr, arg);
    case '$lt':
    case '$lte':
    case '$gt':
    case '$gte':
      return comparisonFilter(field, expr, typeExpr, op, arg);
    case '$size':
      if (typeof arg !== 'number' || arg % 1 !== 0) return null;
      return { sql: `${typeExpr} = 'array' AND ${jsonArrayLength(field)} = ?`, params: [arg] };
    default:
      return null;
  }
};

const fieldFilter = (field: string, value: any, arrayFields?: Set<string>): SqlFilter | null => {
  if (field === '__s' || field === '__refid' || field === '_id') return columnFilter(field, value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return null;

  // NeDB matches array fields element-wise, which JSON path expressions cannot
  // reproduce: never push predicates for fields that have held arrays.
  if (arrayFields && arrayFields.has(field)) return null;

  const expr = jsonExtract(field);
  const typeExpr = jsonTypeOf(field);

  const scalar = eqFilter(field, expr, typeExpr, value);
  if (scalar) return scalar;

  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every(k => k.startsWith('$'))) return null;

  const parts: SqlFilter[] = [];
  for (const op of keys) {
    const part = operatorFilter(field, expr, typeExpr, op, value[op]);
    if (!part) return null; // unsupported operator: don't push this field at all
    parts.push(part);
  }
  return combine(parts, 'AND');
};

/**
 * Build a SQL WHERE clause that is guaranteed to be a superset of the NeDB
 * matches for `query` (possibly null, meaning "no narrowing"). The JS matcher
 * then filters the fetched candidates exactly.
 */
export const buildSqlFilter = (query: any, arrayFields?: Set<string>): SqlFilter | null => {
  if (!isPlainObject(query)) return null;

  const parts: SqlFilter[] = [];
  for (const key of Object.keys(query)) {
    const value = query[key];

    if (key === '$and') {
      if (!Array.isArray(value) || value.length === 0) continue;
      const subs = value.map((sub: any) => buildSqlFilter(sub, arrayFields));
      if (subs.some(s => !s)) continue;
      parts.push(combine(subs as SqlFilter[], 'AND'));
    } else if (key === '$or') {
      if (!Array.isArray(value) || value.length === 0) continue;
      const subs = value.map((sub: any) => buildSqlFilter(sub, arrayFields));
      if (subs.some(s => !s)) continue;
      parts.push(combine(subs as SqlFilter[], 'OR'));
    } else if (key.startsWith('$')) {
      continue; // $not / $where / unknown logical operators
    } else {
      const part = fieldFilter(key, value, arrayFields);
      if (part) parts.push(part);
    }
  }

  return parts.length ? combine(parts, 'AND') : null;
};

/** Fields that already have a base index and must not get auto/extra indexes. */
const BASE_INDEXED_FIELDS = new Set(['_id', '__s', '__refid', 'createdAt', 'updatedAt', 'collection']);

/**
 * Collect top-level fields used as scalar (or scalar `$in`) equality predicates,
 * mirroring the conditions under which `fieldFilter` pushes SQL. Used by the
 * automatic index heuristic.
 */
const collectEqualityFields = (query: any, arrayFields: Set<string>, out = new Set<string>()): Set<string> => {
  if (!isPlainObject(query)) return out;
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (key === '$and' && Array.isArray(value)) {
      for (const sub of value) collectEqualityFields(sub, arrayFields, out);
    } else if (key.startsWith('$')) {
      continue;
    } else if (!BASE_INDEXED_FIELDS.has(key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !arrayFields.has(key)) {
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out.add(key);
      else if (
        isPlainObject(value) &&
        Object.keys(value).length === 1 &&
        Array.isArray(value.$in) &&
        value.$in.length > 0 &&
        value.$in.every((v: any) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      )
        out.add(key);
    }
  }
  return out;
};

export class SqliteCursor<T = any> {
  private _sort: Record<string, number> | null = null;
  private _limit: number | null = null;
  private _skip: number | null = null;
  private _projection: any = {};

  constructor(private store: SqliteStore, private query: any, private mapFn: (docs: any[]) => T) {}

  sort(spec: Record<string, number>): this {
    this._sort = spec;
    return this;
  }

  limit(value: number): this {
    this._limit = value;
    return this;
  }

  skip(value: number): this {
    this._skip = value;
    return this;
  }

  projection(projection: any): this {
    this._projection = projection;
    return this;
  }

  private project(candidates: any[]): any[] {
    if (this._projection === undefined || Object.keys(this._projection).length === 0) return candidates;

    const res: any[] = [];
    let action: any;
    const projection = { ...this._projection };
    const keepId = projection._id !== 0;
    delete projection._id;

    const keys = Object.keys(projection);
    keys.forEach(k => {
      if (action !== undefined && projection[k] !== action) throw new Error("Can't both keep and omit fields except for _id");
      action = projection[k];
    });

    candidates.forEach(candidate => {
      let toPush: any;
      if (action === 1) {
        // pick-type projection
        toPush = { $set: {} } as any;
        keys.forEach(k => {
          toPush.$set[k] = getDotValue(candidate, k);
          if (toPush.$set[k] === undefined) delete toPush.$set[k];
        });
        toPush = modify({}, toPush);
      } else {
        // omit-type projection
        toPush = { $unset: {} } as any;
        keys.forEach(k => {
          toPush.$unset[k] = true;
        });
        toPush = modify(candidate, toPush);
      }
      if (keepId) toPush._id = candidate._id;
      else delete toPush._id;
      res.push(toPush);
    });

    return res;
  }

  private exec(): T {
    let res: any[] = [];
    let added = 0;
    let skipped = 0;

    const candidates = this.store.fetchCandidates(this.query);

    for (const candidate of candidates) {
      if (match(candidate, this.query)) {
        if (!this._sort) {
          if (this._skip && this._skip > skipped) skipped += 1;
          else {
            res.push(candidate);
            added += 1;
            if (this._limit && this._limit <= added) break;
          }
        } else res.push(candidate);
      }
    }

    if (this._sort) {
      const criteria = Object.entries(this._sort).map(([key, direction]) => ({ key, direction }));
      res.sort((a, b) => {
        for (const criterion of criteria) {
          const compare = criterion.direction * compareThings(getDotValue(a, criterion.key), getDotValue(b, criterion.key));
          if (compare !== 0) return compare;
        }
        return 0;
      });

      const limit = this._limit || res.length;
      const skip = this._skip || 0;
      res = res.slice(skip, skip + limit);
    }

    res = this.project(res);
    return (this.mapFn ? this.mapFn(res) : res) as T;
  }

  async execAsync(): Promise<T> {
    return this.exec();
  }

  then<TResult1 = T, TResult2 = never>(
    onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execAsync().then(onFulfilled, onRejected);
  }

  catch<TResult = never>(onRejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null): Promise<T | TResult> {
    return this.execAsync().catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.execAsync().finally(onFinally);
  }
}

export class SqliteStore {
  public readonly filename: string;
  public readonly timestampData: boolean;
  public readonly corruptAlertThreshold: number;

  private db!: Database;
  private isOpen = false;
  private stmts = new Map<string, Statement>();
  private indexes: Record<string, IndexSpec> = {};
  private ttlIndexes: Record<string, number> = {};
  private arrayFields = new Set<string>();
  private queryFieldHits = new Map<string, number>();
  private autoIndexCount = 0;
  private autoIndexScheduled = new Set<string>();

  private static readonly AUTO_INDEX_THRESHOLD = 25;
  private static readonly AUTO_INDEX_LIMIT = 24;

  constructor(filename: string, options: StoreOptions = {}) {
    this.filename = filename;
    this.timestampData = options.timestampData || false;
    this.corruptAlertThreshold = options.corruptAlertThreshold !== undefined ? options.corruptAlertThreshold : 0.1;
  }

  // ------------------------------------------------------------------
  // Opening / migration
  // ------------------------------------------------------------------

  private static detectFormat(file: string): 'missing' | 'empty' | 'sqlite' | 'nedb' {
    if (!existsSync(file)) return 'missing';
    if (statSync(file).size === 0) return 'empty';
    const fd = openSync(file, 'r');
    const header = Buffer.alloc(16);
    try {
      readSync(fd, header, 0, 16, 0);
    } finally {
      closeSync(fd);
    }
    return header.equals(SQLITE_MAGIC) ? 'sqlite' : 'nedb';
  }

  async loadDatabaseAsync(): Promise<void> {
    mkdirSync(path.dirname(path.resolve(this.filename)), { recursive: true });
    const format = SqliteStore.detectFormat(this.filename);
    if (format === 'nedb') {
      const result = await migrateNedbFile(this.filename, this.corruptAlertThreshold);
      Logger.info(
        `Migrated savedata "${this.filename}" to SQLite (${result.docs} docs${
          result.corruptItems > 0 ? `, ${result.corruptItems} corrupt lines discarded` : ''
        }). Original backed up.`,
        { plugin: 'db' }
      );
    } else if (format === 'sqlite') {
      // already migrated
    }

    this.db = new Database(this.filename);
    // WAL keeps per-write latency close to NeDB's buffered appends while still
    // being crash-safe (NORMAL loses at most the last transaction on power
    // loss, but never corrupts). Sidecar -wal/-shm files exist while running
    // and are checkpointed away on a clean close.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA wal_autocheckpoint = 1000');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA temp_store = MEMORY');

    createTables(this.db);
    createBaseIndexes(this.db);
    this.loadIndexMeta();
    if (format === 'nedb') {
      // Fresh migration has no planner statistics; without them SQLite may pick
      // a low-selectivity index (e.g. collection) and scan the whole table.
      this.db.exec('ANALYZE');
    } else {
      this.db.exec('PRAGMA optimize');
    }
    this.isOpen = true;
  }

  private loadIndexMeta(): void {
    const rows = this.all('SELECT key, value FROM meta') as { key: string; value: string }[];
    for (const row of rows) {
      if (row.key.startsWith('array:')) {
        this.arrayFields.add(row.key.slice('array:'.length));
        continue;
      }
      if (!row.key.startsWith('index:')) continue;
      const fieldName = row.key.slice('index:'.length);
      let spec: IndexSpec;
      try {
        spec = JSON.parse(row.value);
      } catch (err) {
        continue;
      }
      this.indexes[fieldName] = spec;
      if (spec.expireAfterSeconds != null) this.ttlIndexes[fieldName] = spec.expireAfterSeconds;
      // Re-apply idempotently in case the index was dropped out of band.
      const sql = buildIndexSql(spec);
      if (sql) this.db.exec(sql);
    }
    this.autoIndexCount = Object.keys(this.indexes).length;
  }

  close(): void {
    if (!this.isOpen) return;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      // best effort
    }
    this.stmts.clear();
    this.db.close();
    this.isOpen = false;
  }

  // ------------------------------------------------------------------
  // Statement helpers
  // ------------------------------------------------------------------

  private stmt(sql: string): Statement {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.query(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  private all(sql: string, params: Bind[] = []): any[] {
    return this.stmt(sql).all(...(params as any[])) as any[];
  }

  private get(sql: string, params: Bind[] = []): any {
    return this.stmt(sql).get(...(params as any[])) as any;
  }

  private run(sql: string, params: Bind[] = []): any {
    return this.stmt(sql).run(...(params as any[]));
  }

  /**
   * Safety net until plugins can declare indexes explicitly: count equality
   * lookups per field and build an expression index once a field is clearly hot.
   * This keeps NeDB-like plugins with large collections fast without any
   * changes on their side.
   */
  private noteQueryFields(query: any): void {
    if (!isPlainObject(query)) return;
    for (const field of collectEqualityFields(query, this.arrayFields)) {
      if (this.indexes[field] || BASE_INDEXED_FIELDS.has(field)) continue;
      const hits = (this.queryFieldHits.get(field) ?? 0) + 1;
      this.queryFieldHits.set(field, hits);
      if (hits >= SqliteStore.AUTO_INDEX_THRESHOLD && this.autoIndexCount < SqliteStore.AUTO_INDEX_LIMIT) {
        this.scheduleAutoIndex(field);
      }
    }
  }

  private scheduleAutoIndex(field: string): void {
    if (this.autoIndexScheduled.has(field)) return;
    this.autoIndexScheduled.add(field);
    setTimeout(() => {
      this.autoIndexScheduled.delete(field);
      if (!this.isOpen || this.indexes[field]) return;
      try {
        const spec: IndexSpec = { fieldName: field };
        const sql = buildIndexSql(spec);
        if (!sql) return;
        this.db.exec(sql);
        this.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [`index:${field}`, JSON.stringify(spec)]);
        this.indexes[field] = spec;
        this.autoIndexCount += 1;
        this.db.exec(`ANALYZE ${indexName(field)}`);
        Logger.info(`Indexed hot query field "${field}" in "${this.filename}"`, { plugin: 'db' });
      } catch (err) {
        Logger.warn(`Could not create automatic index on "${field}": ${err}`);
      }
    }, 0);
  }

  private transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Remember top-level fields that have held arrays. NeDB matches array fields
   * element-wise, so predicates on those fields can't be pushed to SQL (JSON
   * path expressions see the whole array).
   */
  private noteArrayFields(docs: any[]): void {
    const added: string[] = [];
    for (const doc of docs) {
      for (const key of Object.keys(doc)) {
        if (Array.isArray(doc[key]) && !this.arrayFields.has(key)) {
          this.arrayFields.add(key);
          added.push(key);
        }
      }
    }
    if (added.length > 0) {
      const set = this.stmt('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      for (const field of added) set.run(`array:${field}`, '1');
    }
  }

  // ------------------------------------------------------------------
  // Candidate fetching
  // ------------------------------------------------------------------

  fetchCandidates(query: any, expireStale = true): any[] {
    this.noteQueryFields(query);
    const filter = buildSqlFilter(query, this.arrayFields);
    const rows = filter
      ? this.all(`SELECT doc FROM docs WHERE ${filter.sql}`, filter.params)
      : this.all('SELECT doc FROM docs');

    let docs = rows.map((row: any) => deserialize(row.doc));
    if (expireStale && Object.keys(this.ttlIndexes).length > 0) docs = this.removeExpired(docs);
    return docs;
  }

  private removeExpired(docs: any[]): any[] {
    const expired: string[] = [];
    const remaining: any[] = [];

    for (const doc of docs) {
      let isExpired = false;
      for (const field of Object.keys(this.ttlIndexes)) {
        const value = getDotValue(doc, field);
        if (isDate(value) && Date.now() > value.getTime() + this.ttlIndexes[field] * 1000) {
          isExpired = true;
          break;
        }
      }
      if (isExpired) expired.push(doc._id);
      else remaining.push(doc);
    }

    if (expired.length > 0) {
      const remove = this.stmt('DELETE FROM docs WHERE _id = ?');
      this.transaction(() => {
        for (const id of expired) remove.run(id);
      });
    }

    return remaining;
  }

  private findMatch(query: any, expireStale = true): any | null {
    for (const candidate of this.fetchCandidates(query, expireStale)) {
      if (match(candidate, query)) return candidate;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Public API (NeDB-compatible)
  // ------------------------------------------------------------------

  findAsync<T = any>(query: any, projection: any = {}): SqliteCursor<T[]> {
    const cursor = new SqliteCursor<T[]>(this, query, docs => docs.map(doc => deepCopy(doc)));
    cursor.projection(projection);
    return cursor;
  }

  findOneAsync<T = any>(query: any, projection: any = {}): SqliteCursor<T | null> {
    const cursor = new SqliteCursor<T | null>(this, query, docs => (docs.length === 1 ? deepCopy(docs[0]) : null));
    cursor.projection(projection).limit(1);
    return cursor;
  }

  countAsync(query: any): SqliteCursor<number> {
    return new SqliteCursor<number>(this, query, docs => docs.length);
  }

  private createNewId(): string {
    for (let i = 0; i < 100; i += 1) {
      const attempt = uid(16);
      if (!this.get('SELECT 1 FROM docs WHERE _id = ? LIMIT 1', [attempt])) return attempt;
    }
    throw new Error('Could not generate a unique _id');
  }

  private prepareDocumentForInsertion(newDoc: any): any {
    if (Array.isArray(newDoc)) return newDoc.map(doc => this.prepareDocumentForInsertion(doc));

    const prepared = deepCopy(newDoc);
    if (prepared._id === undefined) prepared._id = this.createNewId();
    const now = new Date();
    if (this.timestampData && prepared.createdAt === undefined) prepared.createdAt = now;
    if (this.timestampData && prepared.updatedAt === undefined) prepared.updatedAt = now;
    checkObject(prepared);
    return prepared;
  }

  private insertRow(doc: any): void {
    this.run('INSERT INTO docs (_id, __s, __refid, createdAt, updatedAt, doc) VALUES (?, ?, ?, ?, ?, ?)', [
      String(doc._id),
      stringOrNull(doc.__s),
      stringOrNull(doc.__refid),
      dateToMs(doc.createdAt),
      dateToMs(doc.updatedAt),
      serialize(doc),
    ]);
  }

  async insertAsync<T = any>(newDoc: T | T[]): Promise<any> {
    const prepared = this.prepareDocumentForInsertion(newDoc);
    const docs = Array.isArray(prepared) ? prepared : [prepared];
    this.transaction(() => {
      for (const doc of docs) this.insertRow(doc);
    });
    this.noteArrayFields(docs);
    return deepCopy(prepared);
  }

  async updateAsync<T = any>(
    query: any,
    update: any,
    options: { multi?: boolean; upsert?: boolean; returnUpdatedDocs?: boolean } = {}
  ): Promise<{ numAffected: number; affectedDocuments: any; upsert: boolean }> {
    const multi = options.multi !== undefined ? options.multi : false;
    const upsert = options.upsert !== undefined ? options.upsert : false;

    if (upsert) {
      const existing = this.findMatch(query);
      if (existing == null) {
        let toBeInserted: any;
        try {
          checkObject(update);
          toBeInserted = update;
        } catch (err) {
          toBeInserted = modify(deepCopy(query, true), update);
        }
        const newDoc = await this.insertAsync(toBeInserted);
        return { numAffected: 1, affectedDocuments: newDoc, upsert: true };
      }
    }

    let numReplaced = 0;
    const modifications: { oldDoc: any; newDoc: any }[] = [];
    let createdAt: any;

    for (const candidate of this.fetchCandidates(query)) {
      if (match(candidate, query) && (multi || numReplaced === 0)) {
        numReplaced += 1;
        if (this.timestampData) createdAt = candidate.createdAt;
        const modifiedDoc = modify(candidate, update);
        if (this.timestampData) {
          modifiedDoc.createdAt = createdAt;
          modifiedDoc.updatedAt = new Date();
        }
        modifications.push({ oldDoc: candidate, newDoc: modifiedDoc });
      }
    }

    if (modifications.length > 0) {
      const updateStmt = this.stmt(
        'UPDATE docs SET doc = ?, __s = ?, __refid = ?, createdAt = ?, updatedAt = ? WHERE _id = ?'
      );
      this.transaction(() => {
        for (const { newDoc } of modifications) {
          updateStmt.run(
            serialize(newDoc),
            stringOrNull(newDoc.__s),
            stringOrNull(newDoc.__refid),
            dateToMs(newDoc.createdAt),
            dateToMs(newDoc.updatedAt),
            String(newDoc._id)
          );
        }
      });
      this.noteArrayFields(modifications.map(m => m.newDoc));
    }

    if (!options.returnUpdatedDocs) return { numAffected: numReplaced, upsert: false, affectedDocuments: null };

    let updatedDocs = modifications.map(m => deepCopy(m.newDoc));
    const affectedDocuments: any = multi ? updatedDocs : updatedDocs[0];
    return { numAffected: numReplaced, upsert: false, affectedDocuments };
  }

  async removeAsync(query: any, options: { multi?: boolean } = {}): Promise<number> {
    const multi = options.multi !== undefined ? options.multi : false;
    const removedIds: string[] = [];

    for (const candidate of this.fetchCandidates(query, false)) {
      if (match(candidate, query) && (multi || removedIds.length === 0)) removedIds.push(candidate._id);
    }

    if (removedIds.length > 0) {
      const remove = this.stmt('DELETE FROM docs WHERE _id = ?');
      this.transaction(() => {
        for (const id of removedIds) remove.run(String(id));
      });
    }

    return removedIds.length;
  }

  // ------------------------------------------------------------------
  // Indexes
  // ------------------------------------------------------------------

  async ensureIndexAsync(options: IndexSpec): Promise<void> {
    if (typeof options?.fieldName !== 'string') throw new Error('Field name must be a string');
    const fieldName = options.fieldName;
    if (this.indexes[fieldName]) return;

    const sql = buildIndexSql(options);
    if (sql) this.db.exec(sql);
    this.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [`index:${fieldName}`, JSON.stringify(options)]);
    this.indexes[fieldName] = options;
    if (options.expireAfterSeconds != null) this.ttlIndexes[fieldName] = options.expireAfterSeconds;
  }

  async removeIndexAsync(fieldName: string): Promise<void> {
    const sql = dropIndexSql(fieldName);
    if (sql) this.db.exec(sql);
    this.run('DELETE FROM meta WHERE key = ?', [`index:${fieldName}`]);
    delete this.indexes[fieldName];
    delete this.ttlIndexes[fieldName];
  }

  /** Test/debug helper: number of stored documents. */
  async countAllAsync(): Promise<number> {
    const row = this.get('SELECT COUNT(*) AS n FROM docs');
    return row ? Number(row.n) : 0;
  }
}

export default SqliteStore;
