/**
 * Minimal ambient declaration for the built-in `node:sqlite` module.
 *
 * @types/node@20 (the version resolved at the repo root) predates the
 * `node:sqlite` typings, but the runtime (Node >= 22) ships the module. We only
 * declare the synchronous surface this package actually uses.
 */
declare module "node:sqlite" {
  export type SQLValue = string | number | bigint | null | Uint8Array;

  export interface StatementSync {
    run(...params: SQLValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get<T = Record<string, SQLValue>>(...params: SQLValue[]): T | undefined;
    all<T = Record<string, SQLValue>>(...params: SQLValue[]): T[];
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
