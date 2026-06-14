/**
 * Tenant isolation regression suite.
 *
 * Covers the C-1 / C-2 / C-3 / L-1 fixes from the security audit:
 *   - C-1: domain models carry tenantId end-to-end; postgres adapters fail
 *          closed when missing.
 *   - C-2: LiveExecutionEngine stamps tenantId on the execution record and
 *          on every emitted LiveEvent; the broadcaster filter delivers
 *          events only to the owning tenant.
 *   - C-3: QuotaEnforcer.checkExecutionStart() atomically reserves the
 *          concurrent slot and never exceeds the configured limit under
 *          burst concurrency.
 *   - L-1: production bootstrap rejects missing DATABASE_URL / permissive
 *          tenant guard.
 *
 * These are unit-level tests — the full HTTP+Postgres integration coverage
 * lives in apps/api/test/integration/postgres/.
 */

import { describe, expect, it, vi } from "vitest";
import { LiveExecutionEngine } from "../src/runtime/execution-engine.js";
import { LiveEventBroadcaster } from "../src/events/live-broadcaster.js";
import type { LiveEvent } from "../src/telemetry/live-events.js";
import { QuotaEnforcer } from "../src/infrastructure/quota/quotaEnforcer.js";
import {
  TenantGuard,
  createPermissiveTenantGuard,
  ResourceTenantNotResolvableError,
  CrossTenantAccessError
} from "../src/infrastructure/security/tenantGuard.js";
import type { TenantContext } from "../src/infrastructure/security/tenantContext.js";

// ── Minimal Groq stub — yields one token then completes. ──────────────────
function stubGroq(model = "stub-model") {
  return {
    modelName: model,
    async isAvailable() { return true; },
    async *runPrompt(_input: { prompt: string }) {
      yield { token: "hello", done: false } as { token: string; done: boolean };
      yield {
        token: "",
        done: true,
        promptEvalCount: 1,
        evalCount: 1,
        totalDurationNs: 1
      };
    }
  } as unknown as ConstructorParameters<typeof LiveExecutionEngine>[0];
}

describe("C-2 — live engine tenant stamping", () => {
  it("stamps tenantId on the execution record returned to the caller", async () => {
    const broadcaster = new LiveEventBroadcaster();
    const engine = new LiveExecutionEngine(stubGroq(), broadcaster);
    const record = await engine.runPrompt({ prompt: "hi", tenantId: "tenant-alpha" });
    expect(record.tenantId).toBe("tenant-alpha");
  });

  it("stamps tenantId on every emitted LiveEvent", async () => {
    const broadcaster = new LiveEventBroadcaster();
    const events: LiveEvent[] = [];
    broadcaster.subscribe((e) => events.push(e));
    const engine = new LiveExecutionEngine(stubGroq(), broadcaster);
    await engine.runPrompt({ prompt: "hi", tenantId: "tenant-alpha" });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.tenantId).toBe("tenant-alpha");
    }
  });

  it("SSE broadcaster filter does not leak events across tenants", async () => {
    const broadcaster = new LiveEventBroadcaster();
    const alphaEvents: LiveEvent[] = [];
    const betaEvents: LiveEvent[] = [];
    broadcaster.subscribe((e) => alphaEvents.push(e), "tenant-alpha");
    broadcaster.subscribe((e) => betaEvents.push(e), "tenant-beta");
    const engine = new LiveExecutionEngine(stubGroq(), broadcaster);
    await engine.runPrompt({ prompt: "hi", tenantId: "tenant-alpha" });
    expect(alphaEvents.length).toBeGreaterThan(0);
    expect(betaEvents.length).toBe(0);
  });

  it("history() filters by tenant — no untagged leak under a tenant filter", async () => {
    const broadcaster = new LiveEventBroadcaster();
    const engine = new LiveExecutionEngine(stubGroq(), broadcaster);
    await engine.runPrompt({ prompt: "hi", tenantId: "tenant-alpha" });
    expect(broadcaster.history(undefined, "tenant-alpha").length).toBeGreaterThan(0);
    expect(broadcaster.history(undefined, "tenant-beta").length).toBe(0);
  });
});

// ── C-3: atomic quota reservation ─────────────────────────────────────────

class FakeRedis {
  private counters = new Map<string, number>();
  async incr(key: string): Promise<number> {
    const v = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, v);
    return v;
  }
  async decr(key: string): Promise<number> {
    const v = (this.counters.get(key) ?? 0) - 1;
    this.counters.set(key, v);
    return v;
  }
  async get(key: string): Promise<string | null> {
    return this.counters.has(key) ? String(this.counters.get(key)) : null;
  }
  async set(key: string, v: string): Promise<"OK"> {
    this.counters.set(key, Number(v));
    return "OK";
  }
  async setex(key: string, _ttl: number, v: string): Promise<"OK"> {
    this.counters.set(key, Number(v));
    return "OK";
  }
  async expire(_key: string, _ttl: number): Promise<number> { return 1; }
  async ttl(_key: string): Promise<number> { return 3600; }
  // Test helper.
  peek(key: string): number { return this.counters.get(key) ?? 0; }
}

function fakeDb(limits: { max_executions_per_hour: number; max_events_per_day: number; max_concurrent_executions: number; max_agents: number }) {
  return {
    async query() {
      return { rows: [limits], rowCount: 1 };
    },
    async withTransaction(fn: (tx: unknown) => unknown) { return fn(this); },
    async close() { /* noop */ }
  } as unknown as ConstructorParameters<typeof QuotaEnforcer>[1];
}

describe("C-3 — atomic concurrent execution quotas", () => {
  it("never exceeds maxConcurrentExecutions under burst concurrency", async () => {
    const redis = new FakeRedis();
    const db = fakeDb({
      max_executions_per_hour: 10_000,
      max_events_per_day: 10_000,
      max_concurrent_executions: 3,
      max_agents: 100
    });
    const enforcer = new QuotaEnforcer(redis as never, db, true);

    const tenant = "tenant-alpha";
    // Burst 20 simultaneous reservations against a limit of 3.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => enforcer.checkExecutionStart(tenant))
    );

    const allowed = results.filter((r) => r.allowed);
    const denied = results.filter((r) => !r.allowed);

    expect(allowed.length).toBe(3);
    expect(denied.length).toBe(17);
    for (const d of denied) {
      expect(d.reason).toBe("CONCURRENT_EXECUTIONS_EXCEEDED");
    }
    // The counter must equal the number of successful reservations — rolled
    // back denials must NOT have been permanently charged.
    expect(redis.peek(`quota:exec:concurrent:${tenant}`)).toBe(3);
  });

  it("trackExecutionEnd brings the counter back down so new reservations succeed", async () => {
    const redis = new FakeRedis();
    const db = fakeDb({
      max_executions_per_hour: 10_000,
      max_events_per_day: 10_000,
      max_concurrent_executions: 2,
      max_agents: 100
    });
    const enforcer = new QuotaEnforcer(redis as never, db, true);
    const tenant = "tenant-beta";

    expect((await enforcer.checkExecutionStart(tenant)).allowed).toBe(true);
    expect((await enforcer.checkExecutionStart(tenant)).allowed).toBe(true);
    expect((await enforcer.checkExecutionStart(tenant)).allowed).toBe(false);
    await enforcer.trackExecutionEnd(tenant);
    expect((await enforcer.checkExecutionStart(tenant)).allowed).toBe(true);
  });

  it("legacy trackExecutionStart is a no-op (does not double-charge)", async () => {
    const redis = new FakeRedis();
    const db = fakeDb({
      max_executions_per_hour: 10_000,
      max_events_per_day: 10_000,
      max_concurrent_executions: 5,
      max_agents: 100
    });
    const enforcer = new QuotaEnforcer(redis as never, db, true);
    const tenant = "tenant-gamma";
    await enforcer.checkExecutionStart(tenant);
    await enforcer.trackExecutionStart(tenant); // shim — must not increment
    expect(redis.peek(`quota:exec:concurrent:${tenant}`)).toBe(1);
  });
});

// ── L-1: permissive guard exposure ────────────────────────────────────────

describe("L-1 — TenantGuard mode introspection", () => {
  it("permissive dev guard reports isPermissive=true", () => {
    const guard = createPermissiveTenantGuard();
    expect(guard.isPermissive).toBe(true);
  });

  it("strict guard reports isPermissive=false", () => {
    const stubDb = {
      async query() { return { rows: [], rowCount: 0 }; },
      async withTransaction(fn: (tx: unknown) => unknown) { return fn(stubDb); },
      async close() { /* noop */ }
    };
    const guard = new TenantGuard({ db: stubDb as never, permitWhenNotFound: false });
    expect(guard.isPermissive).toBe(false);
  });
});

// ── L-2: malformed identifier never escapes as an opaque 500 ──────────────────
// A non-uuid string handed to a uuid-keyed column makes Postgres raise 22P02
// (invalid_text_representation). Previously that error bubbled out of the route
// as INTERNAL_ERROR (500) — the operator console's Root Cause panel rendered it
// as "INTERNAL_ERROR (500): Unexpected runtime error". A value that cannot even
// be a valid key can never own a row, so the guard must treat it as
// "not resolvable" (→ 403), identical to a non-existent id.

describe("L-2 — malformed id (Postgres 22P02) is not an opaque 500", () => {
  function dbThrowing22P02() {
    const err = Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    const db = {
      async query() { throw err; },
      async withTransaction(fn: (tx: unknown) => unknown) { return fn(db); },
      async close() { /* noop */ }
    };
    return db;
  }

  it("strict guard maps a 22P02 to ResourceTenantNotResolvableError (→403), not the raw error", async () => {
    const guard = new TenantGuard({ db: dbThrowing22P02() as never, permitWhenNotFound: false });
    await expect(guard.resolveExecutionTenant("not-a-real-exec-id")).rejects.toBeInstanceOf(
      ResourceTenantNotResolvableError
    );
  });

  it("permissive guard degrades a 22P02 to null (permits) instead of throwing", async () => {
    const guard = new TenantGuard({ db: dbThrowing22P02() as never, permitWhenNotFound: true });
    await expect(guard.resolveExecutionTenant("not-a-real-exec-id")).resolves.toBeNull();
  });

  it("a non-22P02 db error still propagates under the strict guard", async () => {
    const boom = Object.assign(new Error("connection reset"), { code: "08006" });
    const db = {
      async query() { throw boom; },
      async withTransaction(fn: (tx: unknown) => unknown) { return fn(db); },
      async close() { /* noop */ }
    };
    const guard = new TenantGuard({ db: db as never, permitWhenNotFound: false });
    await expect(guard.resolveExecutionTenant("11111111111111111111111111111111")).rejects.toBe(boom);
  });
});

// ── L-3: an orphaned execution (cognition/checkpoints exist, but the
// `executions` summary row is missing or pruned) must still resolve its owning
// tenant so the operator console can diagnose it. This is the bug behind the
// "FORBIDDEN (403): Cross-tenant access denied" the console showed for a stuck
// execution that genuinely belonged to the operator's own tenant.
describe("L-3 — orphaned execution resolves tenant from non-summary tables", () => {
  // Stub: the fast executions-PK lookup finds nothing; the broad UNION (which
  // includes cognition_graphs/checkpoints/dead-letters) resolves `broadTenant`.
  function dbOrphan(broadTenant: string | null) {
    const db = {
      async query(sql: string) {
        const isBroad = /cognition_graphs|union all/i.test(sql);
        if (isBroad) {
          return broadTenant === null
            ? { rows: [], rowCount: 0 }
            : { rows: [{ tenant_id: broadTenant }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 }; // executions summary row missing
      },
      async withTransaction(fn: (tx: unknown) => unknown) { return fn(db); },
      async close() { /* noop */ }
    };
    return db;
  }

  const orphanId = "3beb80137b2abadee5e25b955ec7aac2";
  const operator = (tenantId: string): TenantContext => ({
    tenantId, apiKeyId: "k", role: "operator", rateLimitRpm: 0
  });

  it("resolves the owning tenant when the executions summary row is missing", async () => {
    const guard = new TenantGuard({ db: dbOrphan("system") as never, permitWhenNotFound: false });
    await expect(guard.resolveExecutionTenant(orphanId)).resolves.toBe("system");
  });

  it("permits the owning tenant's operator to diagnose its orphaned execution", async () => {
    const guard = new TenantGuard({ db: dbOrphan("system") as never, permitWhenNotFound: false });
    await expect(guard.assertOwnsExecution(operator("system"), orphanId)).resolves.toBeUndefined();
  });

  it("still denies a DIFFERENT tenant (no IDOR weakening from the broad resolver)", async () => {
    const guard = new TenantGuard({ db: dbOrphan("system") as never, permitWhenNotFound: false });
    await expect(guard.assertOwnsExecution(operator("tenant-b"), orphanId)).rejects.toBeInstanceOf(
      CrossTenantAccessError
    );
  });

  it("a truly unknown id (no record in any table) still denies under the strict guard", async () => {
    const guard = new TenantGuard({ db: dbOrphan(null) as never, permitWhenNotFound: false });
    await expect(guard.resolveExecutionTenant("deadbeefdeadbeefdeadbeefdeadbeef")).rejects.toBeInstanceOf(
      ResourceTenantNotResolvableError
    );
  });
});

// ── C-1: defensive assertions in postgres adapters ───────────────────────

describe("C-1 — postgres repositories reject missing tenantId", () => {
  it("PostgresAgentRepository.save throws TENANT_ID_MISSING when tenantId is absent", async () => {
    // Import lazily so the test only loads pg dependency surface when needed.
    const mod = await import("../src/infrastructure/persistence/postgres/postgresAgentRepository.js");
    const writes: unknown[] = [];
    const fakeDb = {
      async query(...args: unknown[]) {
        writes.push(args);
        return { rows: [], rowCount: 1 };
      },
      async withTransaction(fn: (tx: unknown) => unknown) { return fn(fakeDb); },
      async close() { /* noop */ }
    } as never;
    const repo = new mod.PostgresAgentRepository(fakeDb);
    await expect(
      repo.save({
        id: "agent-1",
        name: "x",
        goal: "x",
        state: "IDLE",
        runtimeStatus: "READY",
        model: { provider: "p", model: "m" },
        tools: [],
        memoryPolicy: { episodicEnabled: true, semanticEnabled: false, maxRetrievedItems: 5 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
        // tenantId intentionally missing
      })
    ).rejects.toMatchObject({ code: "TENANT_ID_MISSING" });
    expect(writes.length).toBe(0); // INSERT must not have been issued
  });

  it("PostgresExecutionRepository.save throws TENANT_ID_MISSING when tenantId is absent", async () => {
    const mod = await import("../src/infrastructure/persistence/postgres/postgresExecutionRepository.js");
    const fakeDb = {
      async query() { return { rows: [], rowCount: 1 }; },
      async withTransaction(fn: (tx: unknown) => unknown) { return fn(fakeDb); },
      async close() { /* noop */ }
    } as never;
    const repo = new mod.PostgresExecutionRepository(fakeDb);
    await expect(
      repo.save({
        id: "exec-1",
        agentId: "agent-1",
        status: "QUEUED",
        input: {},
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    ).rejects.toMatchObject({ code: "TENANT_ID_MISSING" });
  });

  it("PostgresMemoryRepository.add throws TENANT_ID_MISSING when tenantId is absent", async () => {
    const mod = await import("../src/infrastructure/persistence/postgres/postgresMemoryRepository.js");
    const fakeDb = {
      async query() { return { rows: [], rowCount: 1 }; },
      async withTransaction(fn: (tx: unknown) => unknown) { return fn(fakeDb); },
      async close() { /* noop */ }
    } as never;
    const repo = new mod.PostgresMemoryRepository(fakeDb);
    await expect(
      repo.add({
        id: "mem-1",
        agentId: "agent-1",
        type: "TASK_HISTORY",
        content: "test",
        metadata: {},
        createdAt: new Date().toISOString()
      })
    ).rejects.toMatchObject({ code: "TENANT_ID_MISSING" });
  });
});

// keep vi reference live so unused-import lint stays happy
void vi;
