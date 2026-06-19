/**
 * Ephemeral Postgres harness for Sprint Hardening Phase 2.
 *
 * Each test suite gets an isolated database — either a fresh testcontainer
 * (preferred) or a freshly-created schema on an externally-provisioned
 * Postgres (CI / docker-compose fallback). Schema is bootstrapped from the
 * checked-in schema.sql + db/migrations/*.sql so the harness reflects the
 * exact DDL the production runtime expects.
 *
 * Parallel-safety: every harness instance runs in its own database (testcontainer)
 * or its own schema (shared instance). No two suites ever share tables, so
 * `vitest --threads` can fan out without interference.
 *
 * Docker absence: if neither Docker nor INTEGRATION_DATABASE_URL is reachable,
 * `tryStartHarness` returns null and the calling describe block uses
 * `describe.skipIf` to skip cleanly with a single explanation line.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { createPgClient, type PgClient } from "../../../src/infrastructure/persistence/postgres/pgClient.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..", "..");
const SCHEMA_PATH = resolve(API_ROOT, "db", "schema.sql");
const MIGRATIONS_DIR = resolve(API_ROOT, "db", "migrations");

export interface PgHarness {
  /** Connection string for the test database. */
  connectionString: string;
  /** Shared PgClient — closed in `stop()`. */
  pg: PgClient;
  /** Restart the Postgres container (testcontainer mode only). */
  restart?: () => Promise<void>;
  /** Truncate every project table — used between tests in a shared-DB suite. */
  reset(): Promise<void>;
  /** Tear down. Must be idempotent. */
  stop(): Promise<void>;
  /** Provenance string — "testcontainer" or "external". */
  source: "testcontainer" | "external";
}

/**
 * Attempt to bring up a Postgres for the suite. Returns null if Docker is
 * absent AND no external Postgres URL is provided.
 *
 * Resolution order:
 *   1. INTEGRATION_DATABASE_URL  → use external, create disposable schema
 *   2. @testcontainers/postgresql → ephemeral container
 *   3. give up → return null (suite skips)
 */
export async function tryStartHarness(): Promise<PgHarness | null> {
  if (process.env.SKIP_POSTGRES_INTEGRATION === "1") {
    return null;
  }
  const externalUrl = process.env.INTEGRATION_DATABASE_URL;
  if (externalUrl) {
    return startExternalHarness(externalUrl);
  }
  return startContainerHarness();
}

/**
 * Loaded only when the module is actually present. Typed loosely on purpose:
 * @testcontainers/postgresql is an optional devDep, and we don't want the
 * production build to fail if it's missing from a developer's node_modules.
 */
interface TestcontainersStartedPg {
  getConnectionUri(): string;
  restart(): Promise<unknown>;
  stop(): Promise<unknown>;
}

interface TestcontainersBuilder {
  withDatabase(name: string): TestcontainersBuilder;
  withUsername(name: string): TestcontainersBuilder;
  withPassword(pw: string): TestcontainersBuilder;
  withCommand(cmd: string[]): TestcontainersBuilder;
  start(): Promise<TestcontainersStartedPg>;
}

type TestcontainersModule = {
  PostgreSqlContainer: new (image: string) => TestcontainersBuilder;
};

async function startContainerHarness(): Promise<PgHarness | null> {
  // Dynamic import with an opaque module specifier so the file type-checks
  // even when @testcontainers/postgresql is not yet installed (e.g. fresh
  // clone before `npm install`). The runtime path still works once the dep
  // lands.
  let mod: TestcontainersModule;
  try {
    const specifier: string = "@testcontainers/postgresql";
    mod = (await import(specifier)) as unknown as TestcontainersModule;
  } catch {
    // testcontainers not installed — the suite will skip.
    return null;
  }
  const PostgreSqlContainer = mod.PostgreSqlContainer;

  let container: TestcontainersStartedPg;
  try {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("agents_runtime_test")
      .withUsername("agents")
      .withPassword("agents")
      // Tune for test workloads: fast fsync off, smaller checkpoints so
      // 1000-event concurrent append tests don't stall on disk flushes.
      .withCommand([
        "postgres",
        "-c", "fsync=off",
        "-c", "synchronous_commit=off",
        "-c", "full_page_writes=off",
        "-c", "max_connections=200"
      ])
      .start();
  } catch (err) {
    // Docker daemon unreachable — bubble null so the suite can skip with a
    // single line explanation instead of N noisy errors.
    if (process.env.DEBUG_INTEGRATION) {
      // eslint-disable-next-line no-console
      console.warn("[integration] testcontainers start failed:", (err as Error).message);
    }
    return null;
  }

  const connectionString = container.getConnectionUri();
  const client = createPgClient(connectionString);
  await applySchema(client);

  const harnessObj: PgHarness = {
    connectionString,
    pg: client,
    source: "testcontainer",
    async restart() {
      try {
        await harnessObj.pg.close();
      } catch {
        // swallow
      }
      await container.restart();
      harnessObj.connectionString = container.getConnectionUri();
      harnessObj.pg = createPgClient(harnessObj.connectionString);
    },
    async reset() {
      await truncateAll(harnessObj.pg);
    },
    async stop() {
      try { await harnessObj.pg.close(); } catch { /* swallow */ }
      try { await container.stop(); } catch { /* swallow */ }
    }
  };
  return harnessObj;
}

async function startExternalHarness(externalUrl: string): Promise<PgHarness> {
  // External mode: connect to the user-supplied Postgres, create a disposable
  // database per harness so parallel suites never share tables.
  const adminPool = new pg.Pool({ connectionString: externalUrl });
  const dbName = `agents_it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await adminPool.query(`create database "${dbName}"`);
  } finally {
    await adminPool.end();
  }
  const targetUrl = rewriteDatabase(externalUrl, dbName);
  const client = createPgClient(targetUrl);
  await applySchema(client);

  return {
    connectionString: targetUrl,
    pg: client,
    source: "external",
    async reset() {
      await truncateAll(client);
    },
    async stop() {
      try { await client.close(); } catch { /* swallow */ }
      // Drop the disposable database. Need a fresh admin connection — the
      // target connection is on the db we're trying to drop.
      const admin = new pg.Pool({ connectionString: externalUrl });
      try {
        await admin.query(`drop database if exists "${dbName}" with (force)`);
      } catch {
        // best-effort — if drop fails the user can clean up manually
      } finally {
        await admin.end();
      }
    }
  };
}

async function applySchema(client: PgClient): Promise<void> {
  const baseSchema = await readFile(SCHEMA_PATH, "utf8");
  await client.query(baseSchema);

  const migrations = await collectMigrations();
  for (const sql of migrations) {
    await client.query(sql);
  }
}

async function collectMigrations(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  let files: string[] = [];
  try {
    files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return [];
  }
  const contents = await Promise.all(
    files.map((f) => readFile(resolve(MIGRATIONS_DIR, f), "utf8"))
  );
  return contents;
}

/**
 * TRUNCATE every project table in dependency-safe order with CASCADE.
 * Faster than DROP+CREATE between tests, and preserves sequences if we
 * include RESTART IDENTITY. We DO restart identity so `events.sequence`
 * is predictable per-test.
 */
async function truncateAll(client: PgClient): Promise<void> {
  // Tables ordered so CASCADE never has to break a cycle; in practice the
  // single statement is fine because we list everything.
  await client.query(`
    truncate table
      event_outbox,
      event_outbox_dlq,
      event_execution_links,
      event_cognition_links,
      replay_certifications,
      replay_frames,
      replay_snapshots,
      replay_branches,
      replay_sessions,
      cognition_lineage,
      cognition_nodes,
      cognition_handoffs,
      cognition_graphs,
      failure_signals,
      execution_checkpoints,
      execution_leases,
      runtime_workers,
      tool_calls,
      execution_steps,
      memory_records,
      events,
      executions,
      agents
    restart identity cascade
  `);
}

function rewriteDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}
