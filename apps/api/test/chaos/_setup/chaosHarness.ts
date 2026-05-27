/**
 * chaosHarness — brings up real Redis and Postgres containers for the chaos
 * suite, or attaches to externally provided URLs, or returns null so the
 * suite skips cleanly when neither is available.
 *
 * Resolution order per service:
 *   REDIS_URL    → CHAOS_REDIS_URL    → testcontainers      → null
 *   DATABASE_URL → CHAOS_DATABASE_URL → testcontainers (PG) → null
 *
 * The harness installs CHAOS_ENABLED=true into process.env BEFORE any
 * application module is imported by the test, then resets the chaos
 * controller so the suite starts with a clean state.
 *
 * Schema for Postgres is the same schema.sql + migrations the runtime applies
 * — we reuse the postgres test harness rather than re-bootstrapping by hand.
 */

import type { Redis } from "ioredis";
import type { PgClient } from "../../../src/infrastructure/persistence/postgres/pgClient.js";
import { tryStartHarness as tryStartPgHarness } from "../../integration/postgres/harness.js";

export interface ChaosHarness {
  redisUrl: string;
  databaseUrl: string;
  redis: Redis;
  pg: PgClient;
  source: { redis: "external" | "testcontainer"; pg: "external" | "testcontainer" };
  stop(): Promise<void>;
}

interface StartedRedisContainer {
  getHost(): string;
  getMappedPort(p: number): number;
  stop(): Promise<unknown>;
}

interface GenericContainer {
  withExposedPorts(p: number): GenericContainer;
  withCommand(cmd: string[]): GenericContainer;
  start(): Promise<StartedRedisContainer>;
}

type TestcontainersGeneric = {
  GenericContainer: new (image: string) => GenericContainer;
};

/**
 * Bring up the chaos harness or return null. The caller uses describe.skipIf
 * to skip the whole suite cleanly when the harness cannot start.
 */
export async function tryStartChaosHarness(): Promise<ChaosHarness | null> {
  // Force CHAOS_ENABLED=true so the proxy layer is active. We also force
  // NODE_ENV to "test" so the strict-prod guards refuse to misfire.
  process.env.CHAOS_ENABLED = "true";
  process.env.NODE_ENV = "test";

  let pgHarness;
  try {
    pgHarness = await tryStartPgHarness();
  } catch (e) {
    if (process.env.DEBUG_INTEGRATION) {
      // eslint-disable-next-line no-console
      console.error("[chaos-harness] pg harness threw:", (e as Error).message);
    }
    return null;
  }
  if (!pgHarness) return null;

  const redisInfo = await resolveRedis();
  if (!redisInfo) {
    await pgHarness.stop();
    return null;
  }

  // Use createRedisClient so chaos proxy is applied — this is the same client
  // path that production uses.
  const { createRedisClient } = await import("../../../src/infrastructure/reliability/redisClient.js");
  const redis = createRedisClient(redisInfo.url, { name: "chaos-harness" });

  // Wait for ready so the test doesn't race connect.
  if (redis.status !== "ready" && redis.status !== "connect") {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("[chaos] redis ready timeout")), 5_000);
      redis.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });
      redis.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  // Flush any residual state from a prior phase/run. When REDIS_URL points at
  // an external (shared) instance, every chaos file connects to the same
  // database, so leftover keys from a previous phase will corrupt depth
  // assertions in this one. With testcontainers each harness gets its own
  // process so this is a no-op there. Resetting the chaos controller is
  // separate — handled per-test by `chaosController().reset()`.
  try {
    await redis.flushdb();
  } catch {
    /* best-effort — if FLUSHDB is disabled the tests will surface real noise */
  }

  return {
    redisUrl: redisInfo.url,
    databaseUrl: pgHarness.connectionString,
    redis,
    pg: pgHarness.pg,
    source: { redis: redisInfo.source, pg: pgHarness.source },
    async stop() {
      try { await redis.quit(); } catch { /* ignore */ }
      try { await redisInfo.stop(); } catch { /* ignore */ }
      try { await pgHarness.stop(); } catch { /* ignore */ }
    }
  };
}

async function resolveRedis(): Promise<{ url: string; source: "external" | "testcontainer"; stop: () => Promise<void> } | null> {
  const external = process.env.CHAOS_REDIS_URL ?? process.env.REDIS_URL;
  if (external) {
    return { url: external, source: "external", stop: async () => undefined };
  }
  try {
    const specifier: string = "testcontainers";
    const mod = (await import(specifier)) as unknown as TestcontainersGeneric;
    const container = await new mod.GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withCommand(["redis-server", "--save", "", "--appendonly", "no"])
      .start();
    const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    return {
      url,
      source: "testcontainer",
      stop: async () => {
        try { await container.stop(); } catch { /* ignore */ }
      }
    };
  } catch {
    return null;
  }
}
