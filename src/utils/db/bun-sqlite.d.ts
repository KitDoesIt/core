/**
 * Minimal type declarations for Bun's built-in SQLite module.
 *
 * The project targets tsc without Bun's global types (see `declare const Bun`
 * in src/http/Engine.ts), so only the subset used by the SQLite backend is
 * declared here.
 */
declare module 'bun:sqlite' {
  export type SQLQueryBindings = string | number | bigint | boolean | null | Uint8Array;

  export class Statement<TReturn = any> {
    all(...params: SQLQueryBindings[]): TReturn[];
    get(...params: SQLQueryBindings[]): TReturn | null;
    run(...params: SQLQueryBindings[]): { lastInsertRowid: number | bigint; changes: number | bigint };
    values(...params: SQLQueryBindings[]): any[][];
    finalize(): void;
  }

  export class Database {
    constructor(
      filename?: string,
      options?: { create?: boolean; readonly?: boolean; strict?: boolean }
    );
    query<TReturn = any>(sql: string): Statement<TReturn>;
    prepare<TReturn = any>(sql: string): Statement<TReturn>;
    exec(sql: string): void;
    transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
    close(): void;
  }
}
