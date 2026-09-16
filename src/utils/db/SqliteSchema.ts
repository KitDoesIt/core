/**
 * SQLite schema helpers for the NeDB-compatible document store.
 *
 * The store is intentionally schemaless from the plugins' point of view:
 * every document lives in `docs.doc` as NeDB-serialized JSON, while `_id`,
 * `__s` and `__refid` are duplicated into real columns so they can be
 * indexed/queried cheaply, exactly like NeDB's built-in indexes.
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';

export const SCHEMA_VERSION = 1;

/** Columns that are real SQLite columns rather than JSON paths. */
export const REAL_COLUMNS: Record<string, string> = {
  _id: '_id',
  __s: '__s',
  __refid: '__refid',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

export const createTables = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      _id TEXT PRIMARY KEY,
      __s TEXT,
      __refid TEXT,
      createdAt REAL,
      updatedAt REAL,
      doc TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
};

export const createBaseIndexes = (db: Database): void => {
  db.exec('CREATE INDEX IF NOT EXISTS idx_docs_s ON docs(__s)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_docs_ref ON docs(__refid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_docs_created ON docs(createdAt)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs(updatedAt)');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_docs_coll ON docs(${jsonExtract('collection')})`);
};

/**
 * Build a SQLite JSON path for a NeDB dot-notation field name.
 *
 * Simple identifier segments are emitted as `$.field` (not `$."field"`) so the
 * generated expression matches the literal used when creating expression
 * indexes; SQLite only reuses an expression index when the expression is
 * identical.
 */
export const jsonPath = (fieldName: string): string => {
  const parts = fieldName.split('.');
  let out = '$';
  for (const part of parts) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) out += `.${part}`;
    else if (/^\d+$/.test(part)) out += `[${part}]`;
    else out += `."${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return out;
};

/** `json_extract(doc, '<path>')` expression for a field name. */
export const jsonExtract = (fieldName: string): string => `json_extract(doc, ${sqlString(jsonPath(fieldName))})`;

/** `json_type(doc, '<path>')` expression for a field name. */
export const jsonTypeOf = (fieldName: string): string => `json_type(doc, ${sqlString(jsonPath(fieldName))})`;

/** `json_array_length(doc, '<path>')` expression for a field name. */
export const jsonArrayLength = (fieldName: string): string => `json_array_length(doc, ${sqlString(jsonPath(fieldName))})`;

export const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Deterministic, safe SQLite index name for a NeDB field name. */
export const indexName = (fieldName: string): string => `idx_nd_${createHash('sha1').update(fieldName).digest('hex').slice(0, 16)}`;

export interface IndexSpec {
  fieldName: string;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
}

/**
 * SQL to create the SQLite counterpart of a NeDB index, or null when the
 * field is already covered by a base index (real columns / primary key).
 */
export const buildIndexSql = (spec: IndexSpec): string | null => {
  if (REAL_COLUMNS[spec.fieldName]) return null;

  const expr = jsonExtract(spec.fieldName);
  const name = indexName(spec.fieldName);
  // NeDB sparse skips documents where the field is *missing*; JSON null is
  // indexed (and therefore subject to a unique constraint).
  const where = spec.sparse ? ` WHERE ${jsonTypeOf(spec.fieldName)} IS NOT NULL` : '';
  return `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON docs(${expr})${where}`;
};

export const dropIndexSql = (fieldName: string): string | null => {
  if (REAL_COLUMNS[fieldName]) return null;
  return `DROP INDEX IF EXISTS ${indexName(fieldName)}`;
};
