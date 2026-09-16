/**
 * One-way migration from a NeDB data file to the SQLite document store.
 *
 * The NeDB file format is an append-only newline-delimited JSON log:
 *   - documents (with `$$date` wrappers for Dates),
 *   - `{"$$deleted":true,"_id":...}` tombstones,
 *   - `{"$$indexCreated":{...}}` / `{"$$indexRemoved":"field"}` index changes.
 *
 * Replaying it with plain JSON.parse (no NeDB dependency) yields exactly the
 * state NeDB would load: last document per `_id` wins, tombstones delete.
 * The original file is backed up under `savedata/_nedb_backup/` and the SQLite
 * file atomically replaces it, keeping the one-file-per-plugin scheme.
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, createReadStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { buildIndexSql, createBaseIndexes, createTables, IndexSpec } from './SqliteSchema';

export interface MigrateResult {
  docs: number;
  corruptItems: number;
}

const dateToMs = (value: any): number | null => {
  if (value && typeof value === 'object' && typeof value.$$date === 'number') return value.$$date;
  if (value instanceof Date) return value.getTime();
  return null;
};

const stringOrNull = (value: any): string | null => (typeof value === 'string' ? value : value == null ? null : String(value));

export const migrateNedbFile = async (file: string, corruptAlertThreshold: number): Promise<MigrateResult> => {
  const tmpFile = `${file}.migrate.tmp`;
  if (existsSync(tmpFile)) unlinkSync(tmpFile);

  const db = new Database(tmpFile);
  // The temp file is disposable until it replaces the original, favour speed.
  db.exec('PRAGMA journal_mode = OFF');
  db.exec('PRAGMA synchronous = OFF');
  createTables(db);

  const insert = db.query(
    'INSERT INTO docs (_id, __s, __refid, createdAt, updatedAt, doc) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(_id) DO UPDATE SET __s = excluded.__s, __refid = excluded.__refid, createdAt = excluded.createdAt, updatedAt = excluded.updatedAt, doc = excluded.doc'
  );
  const remove = db.query('DELETE FROM docs WHERE _id = ?');
  const setMeta = db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

  const indexes: Record<string, IndexSpec> = {};
  const arrayFields = new Set<string>();
  let dataLength = 0;
  let corruptItems = 0;
  let docs = 0;

  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  db.exec('BEGIN');
  try {
    for await (const line of rl) {
      if (line === '') continue;
      dataLength += 1;

      let doc: any;
      try {
        doc = JSON.parse(line);
      } catch (err) {
        corruptItems += 1;
        continue;
      }

      if (doc && doc._id !== undefined) {
        if (doc.$$deleted === true) {
          remove.run(String(doc._id));
        } else {
          insert.run(
            String(doc._id),
            stringOrNull(doc.__s),
            stringOrNull(doc.__refid),
            dateToMs(doc.createdAt),
            dateToMs(doc.updatedAt),
            line
          );
          docs += 1;
          for (const key of Object.keys(doc)) {
            if (Array.isArray(doc[key])) arrayFields.add(key);
          }
        }
      } else if (doc && doc.$$indexCreated && doc.$$indexCreated.fieldName != null) {
        indexes[doc.$$indexCreated.fieldName] = doc.$$indexCreated;
      } else if (doc && typeof doc.$$indexRemoved === 'string') {
        delete indexes[doc.$$indexRemoved];
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    rl.close();
    db.close();
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
    throw err;
  }
  rl.close();

  if (dataLength > 0) {
    const corruptionRate = corruptItems / dataLength;
    if (corruptionRate > corruptAlertThreshold) {
      db.close();
      unlinkSync(tmpFile);
      const error: any = new Error(
        `${Math.floor(100 * corruptionRate)}% of the data file is corrupt, more than given corruptAlertThreshold (${Math.floor(
          100 * corruptAlertThreshold
        )}%). Cautiously refusing to start NeDB to prevent dataloss.`
      );
      error.corruptionRate = corruptionRate;
      error.corruptItems = corruptItems;
      error.dataLength = dataLength;
      throw error;
    }
  }

  // Recreate the indexes declared in the NeDB file, plus the base ones.
  createBaseIndexes(db);
  for (const fieldName of Object.keys(indexes)) {
    const spec = indexes[fieldName];
    const sql = buildIndexSql(spec);
    if (sql) db.exec(sql);
    setMeta.run(`index:${fieldName}`, JSON.stringify(spec));
  }
  for (const fieldName of arrayFields) {
    setMeta.run(`array:${fieldName}`, '1');
  }

  db.exec(`PRAGMA user_version = 1`);
  db.close();

  // Back up the original file, then atomically replace it with the SQLite one.
  const backupDir = path.join(path.dirname(file), '_nedb_backup');
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(file, path.join(backupDir, path.basename(file)));
  renameSync(tmpFile, file);

  return { docs, corruptItems };
};

export default migrateNedbFile;
