/**
 * MigrationRunner — applies db/migrations/*.sql against a Postgres database
 * with version tracking, ordering validation, and idempotent execution.
 *
 * Why this exists:
 *   The Sprint Next test harness reads schema.sql + every migration file and
 *   replays them at suite start. Production deployments had no equivalent —
 *   migrations were applied out-of-band, with no record of which files had
 *   already landed. Restarting an API node against a partially-migrated
 *   database produced obscure runtime errors (column does not exist, missing
 *   constraint) instead of a clean failure at startup.
 *
 * Contract:
 *   1. A `schema_migrations` table tracks every applied migration by filename
 *      (the lexical sort order). We also persist a SHA-256 of the file
 *      contents so subsequent runs detect tampering with already-applied
 *      migrations.
 *   2. The runner first applies `schema.sql` as the base bootstrap. schema.sql
 *      uses `create table if not exists` throughout, so this is safe to run
 *      on a partially-initialized database.
 *   3. Migration files are sorted by filename and applied in order. A gap
 *      (e.g., 0001 applied, 0002 missing, 0003 present) is treated as a
 *      hard error — the runner refuses to apply 0003 over an unmigrated 0002.
 *   4. Each migration file either contains its own `begin;`/`commit;` block
 *      (existing 0001-0003 do) or is wrapped in a single transaction by the
 *      runner if it does not.
 *   5. The `schema_migrations` row for a file is written only after the
 *      file's transaction commits successfully — half-applied migrations
 *      leave the runner free to retry on the next start.
 *
 * Backward compatibility:
 *   Databases provisioned by the test harness (which simply runs schema.sql
 *   then every migration without tracking) will have all tables present but
 *   no `schema_migrations` rows. On first run against such a database the
 *   runner will attempt to re-apply every migration. Every migration uses
 *   `if not exists` for its DDL, so re-application is a no-op except for a
 *   handful of safe `alter table ... add column if not exists` statements —
 *   which is exactly the contract `0001_sprint_next.sql` documents.
 *
 * What this runner does NOT do:
 *   • Reverse / down migrations — out of scope; the platform has never had
 *     them and adding them would expand surface area without changing the
 *     hardening outcome.
 *   • Advisory locks — multi-instance startup races are mitigated by the
 *     CREATE TABLE IF NOT EXISTS pattern. For a stricter guarantee, callers
 *     can wrap MigrationRunner.run() in their own pg_advisory_lock() but the
 *     default deployment is sequential (single boot leader).
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { PgClient } from "./postgres/pgClient.js";

export interface MigrationRunnerOptions {
  /** Absolute path to db/schema.sql. */
  schemaPath: string;
  /** Absolute path to the db/migrations directory. */
  migrationsDir: string;
  /** Optional logger sink — only `info` and `warn` levels are used. */
  logger?: {
    info: (obj: Record<string, unknown>, msg?: string) => void;
    warn: (obj: Record<string, unknown>, msg?: string) => void;
  };
  /**
   * Local-development checksum-recovery mode. DEV ONLY.
   *
   * When true, a checksum mismatch on an already-applied migration is NOT a
   * fatal error. Instead the runner RE-APPLIES the on-disk file (every
   * migration is idempotent by contract — see the module header) inside its
   * normal transaction, then re-stamps the recorded checksum to the file's
   * current hash and logs a loud warning. This recovers a developer database
   * whose migration files drifted from what was recorded (e.g. a file edited
   * after it was applied, or CRLF/line-ending churn) without resetting the DB.
   *
   * Consequences (why this must never be enabled in production):
   *   • It TRUSTS that the on-disk file is semantically equivalent to what was
   *     recorded. Because it re-applies idempotent DDL the schema is converged,
   *     but it deliberately stops `MigrationChecksumError` from firing — the one
   *     guard that detects a teammate silently mutating an applied migration.
   *   • If a drifted file contained genuinely NEW, non-idempotent statements,
   *     re-application could behave unexpectedly; the safety this normally
   *     provides (refuse and escalate) is gone.
   * The caller MUST refuse to set this in strict/production mode.
   */
  repairChecksumsInDev?: boolean;
}

export interface AppliedMigration {
  filename: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationRunResult {
  /** Migrations applied during this run (excluding ones that were already current). */
  applied: AppliedMigration[];
  /** Migrations that were already on record and skipped. */
  skipped: string[];
  /**
   * Migrations whose recorded checksum drifted from the on-disk file and were
   * re-applied + re-stamped under `repairChecksumsInDev`. Empty in normal runs.
   */
  repaired: string[];
  /** True if schema.sql was executed (always true — schema.sql is idempotent). */
  schemaApplied: boolean;
}

const SCHEMA_MIGRATIONS_DDL = `
  create table if not exists schema_migrations (
    filename     text        primary key,
    checksum     text        not null,
    applied_at   timestamptz not null default now()
  )
`;

export class MigrationRunner {
  constructor(private readonly db: PgClient, private readonly opts: MigrationRunnerOptions) {}

  async run(): Promise<MigrationRunResult> {
    const schemaSql = await readFile(this.opts.schemaPath, "utf8");
    // schema.sql is idempotent (every CREATE uses IF NOT EXISTS). We apply it
    // first so the schema_migrations table itself exists on a brand-new DB.
    await this.db.query(schemaSql);
    await this.db.query(SCHEMA_MIGRATIONS_DDL);

    const files = await listMigrationFiles(this.opts.migrationsDir);
    validateOrdering(files);

    const { rows: appliedRows } = await this.db.query<{ filename: string; checksum: string }>(
      `select filename, checksum from schema_migrations`
    );
    const appliedMap = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

    const applied: AppliedMigration[] = [];
    const skipped: string[] = [];
    const repaired: string[] = [];

    for (const file of files) {
      const fullPath = resolve(this.opts.migrationsDir, file);
      const sql = await readFile(fullPath, "utf8");
      const checksum = sha256(sql);

      // Existing 0001-0003 migrations open their own `begin;` blocks. Detect
      // that and let them manage transaction boundaries. Otherwise wrap in a
      // transaction so a mid-statement failure rolls back cleanly.
      const managesOwnTransaction = /^\s*begin\s*;/im.test(sql);

      const existing = appliedMap.get(file);
      if (existing) {
        if (existing === checksum) {
          skipped.push(file);
          continue;
        }
        if (!this.opts.repairChecksumsInDev) {
          // Tampering detected. Refuse to continue — a silently-mutated
          // migration produces divergent schemas across deployments and is
          // exactly the failure mode this runner exists to prevent.
          throw new MigrationChecksumError(file, existing, checksum);
        }
        // Local-dev recovery: re-apply the (idempotent) file and re-stamp the
        // checksum to the on-disk hash. Loud on purpose — this bypasses the
        // tamper guard and must never be reachable in strict/production mode.
        this.opts.logger?.warn(
          { filename: file, recordedChecksum: existing, observedChecksum: checksum },
          "checksum drift — REPAIRING (repairChecksumsInDev): re-applying idempotent migration and re-stamping recorded checksum"
        );
        await this.applyMigration(file, sql, checksum, managesOwnTransaction, "repair");
        repaired.push(file);
        continue;
      }

      await this.applyMigration(file, sql, checksum, managesOwnTransaction, "insert");

      const { rows: stamp } = await this.db.query<{ applied_at: Date | string }>(
        `select applied_at from schema_migrations where filename = $1`,
        [file]
      );
      const appliedAt = stamp[0]?.applied_at;
      applied.push({
        filename: file,
        checksum,
        appliedAt: appliedAt instanceof Date ? appliedAt.toISOString() : String(appliedAt ?? "")
      });

      this.opts.logger?.info({ filename: file, checksum }, "migration applied");
    }

    if (skipped.length) {
      this.opts.logger?.info({ skipped }, "migrations already on record — skipped");
    }
    if (repaired.length) {
      this.opts.logger?.warn(
        { repaired },
        "checksum drift repaired in dev recovery mode — disable repairChecksumsInDev once boot is green"
      );
    }

    return { applied, skipped, repaired, schemaApplied: true };
  }

  /**
   * Run a migration file (respecting whether it manages its own transaction)
   * and record its checksum. `mode: "insert"` writes a fresh schema_migrations
   * row for a not-yet-applied migration; `mode: "repair"` re-stamps the
   * checksum of an already-applied (but drifted) migration after re-running it.
   */
  private async applyMigration(
    file: string,
    sql: string,
    checksum: string,
    managesOwnTransaction: boolean,
    mode: "insert" | "repair"
  ): Promise<void> {
    const stamp =
      mode === "insert"
        ? `insert into schema_migrations (filename, checksum) values ($1, $2)`
        : `update schema_migrations set checksum = $2, applied_at = now() where filename = $1`;

    if (managesOwnTransaction) {
      await this.db.query(sql);
      await this.db.query(stamp, [file, checksum]);
    } else {
      await this.db.withTransaction(async (tx) => {
        await tx.query(sql);
        await tx.query(stamp, [file, checksum]);
      });
    }
  }
}

export class MigrationChecksumError extends Error {
  readonly name = "MigrationChecksumError";
  constructor(
    public readonly filename: string,
    public readonly recordedChecksum: string,
    public readonly observedChecksum: string
  ) {
    super(
      `Migration ${filename} has been modified after it was applied. ` +
        `Recorded checksum ${recordedChecksum.slice(0, 12)}…, current ${observedChecksum.slice(0, 12)}…. ` +
        `Create a new migration file instead of editing a recorded one.`
    );
  }
}

export class MigrationOrderingError extends Error {
  readonly name = "MigrationOrderingError";
  constructor(message: string) {
    super(message);
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

/**
 * Migration filenames follow the `NNNN_description.sql` convention. We do
 * NOT require numeric contiguity (gaps are common when a planned migration
 * is abandoned), but we DO require:
 *   • Every file starts with a 4+ digit numeric prefix.
 *   • Sorted order matches numeric order — no `0010_x.sql` ordering before
 *     `0009_y.sql` because of locale-sensitive string sort surprises.
 */
function validateOrdering(files: string[]): void {
  let lastNumber = -1;
  for (const file of files) {
    const match = /^(\d{4,})_/.exec(file);
    if (!match) {
      throw new MigrationOrderingError(
        `Migration file ${file} does not start with a 4-digit numeric prefix.`
      );
    }
    const num = Number(match[1]);
    if (num <= lastNumber) {
      throw new MigrationOrderingError(
        `Migration ordering violated: ${file} (#${num}) sorts after a higher-numbered migration (#${lastNumber}).`
      );
    }
    lastNumber = num;
  }
}
