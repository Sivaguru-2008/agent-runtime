import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  InMemoryReplaySessionStore,
  InMemoryReplayCertificationStore
} from "../src/infrastructure/persistence/inMemoryCognitionStores.js";
import type { ReplaySession, ReplayCertification } from "../src/domain/replay.js";
import { AgentMetrics } from "../src/infrastructure/metrics/prometheusMetrics.js";
import {
  withSystemRlsScope,
  withTenantRlsScope
} from "../src/infrastructure/security/tenantRlsScope.js";
import type { TenantContext } from "../src/infrastructure/security/tenantContext.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";

/**
 * Tenant-scope propagation tests (migration 0025 + runtime).
 *
 * These are Docker-free unit tests. They verify the tenant attribution that
 * the platform CAN exercise without a live Postgres:
 *   • the optional ReplaySession/ReplayCertification.tenantId round-trips
 *     through the store contract (the postgres adapters then coalesce-from-
 *     execution; the RLS *behaviour* itself is verified by the integration
 *     suite, which needs a real database);
 *   • the additive per-tenant metric records under a bounded label set;
 *   • the RLS scope helpers set the transaction-local GUCs that activate
 *     migration 0024/0025 enforcement;
 *   • migration 0025 structurally covers every gap table and ships RLS in the
 *     same non-breaking transparent-when-unset mode as 0024.
 */

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function makeSession(overrides: Partial<ReplaySession> = {}): ReplaySession {
  return {
    id: "sess-1",
    cognitionId: "cog-1",
    executionId: "exec-1",
    status: "READY",
    cursor: { frameIndex: 0, eventSequence: 0, speed: 1 },
    frames: [],
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function makeCertification(overrides: Partial<ReplayCertification> = {}): ReplayCertification {
  return {
    executionId: "exec-1",
    workflowVersion: "agent-1@v1",
    eventCount: 3,
    lastEventSequence: 3,
    frameDigests: ["a", "b", "c"],
    chainHash: "deadbeef",
    capturedAt: new Date().toISOString(),
    ...overrides
  };
}

/**
 * Minimal PgClient fake that records every SQL string issued through the
 * transaction the scope helpers open. Only the surface the helpers touch is
 * implemented.
 */
function recordingPgClient(): { db: PgClient; queries: string[] } {
  const queries: string[] = [];
  const tx: PgClient = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
    async withTransaction(fn) {
      return fn(tx);
    },
    async acquire() {
      return { async query() { return { rows: [], rowCount: 0 }; }, release() {} };
    },
    stats() {
      return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 };
    },
    async close() {}
  };
  const db: PgClient = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
    async withTransaction(fn) {
      return fn(tx);
    },
    async acquire() {
      return { async query() { return { rows: [], rowCount: 0 }; }, release() {} };
    },
    stats() {
      return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 };
    },
    async close() {}
  };
  return { db, queries };
}

describe("tenant-scope propagation", () => {
  describe("replay data carries tenant through the store contract", () => {
    it("ReplaySession.tenantId round-trips", async () => {
      const store = new InMemoryReplaySessionStore();
      await store.put(makeSession({ id: "s-a", tenantId: TENANT_A }));
      const got = await store.get("s-a");
      expect(got?.tenantId).toBe(TENANT_A);
    });

    it("ReplayCertification.tenantId round-trips and isolates audit trails", async () => {
      const store = new InMemoryReplayCertificationStore();
      await store.put(makeCertification({ executionId: "e-a", tenantId: TENANT_A }));
      await store.put(makeCertification({ executionId: "e-b", tenantId: TENANT_B }));
      expect((await store.latest("e-a"))?.tenantId).toBe(TENANT_A);
      expect((await store.latest("e-b"))?.tenantId).toBe(TENANT_B);
    });

    it("a session without tenantId stays undefined (back-compat fixtures)", async () => {
      const store = new InMemoryReplaySessionStore();
      await store.put(makeSession({ id: "s-legacy" }));
      const got = await store.get("s-legacy");
      expect(got?.tenantId).toBeUndefined();
    });
  });

  describe("tenant-scoped metric", () => {
    it("records per-tenant operations under a bounded label set", async () => {
      const metrics = new AgentMetrics();
      metrics.tenantOperationsTotal.inc({ tenant_id: TENANT_A, operation: "execution_started" });
      metrics.tenantOperationsTotal.inc({ tenant_id: TENANT_A, operation: "execution_started" });
      metrics.tenantOperationsTotal.inc({ tenant_id: TENANT_B, operation: "execution_started" });

      const snapshot = await metrics.tenantOperationsTotal.get();
      const a = snapshot.values.find(
        (v) => v.labels.tenant_id === TENANT_A && v.labels.operation === "execution_started"
      );
      const b = snapshot.values.find(
        (v) => v.labels.tenant_id === TENANT_B && v.labels.operation === "execution_started"
      );
      expect(a?.value).toBe(2);
      expect(b?.value).toBe(1);
    });
  });

  describe("RLS scope helpers set the transaction-local GUCs", () => {
    it("withSystemRlsScope sets app.bypass_rls=on (background/system path)", async () => {
      const { db, queries } = recordingPgClient();
      await withSystemRlsScope(db, async () => "ok");
      expect(queries.some((q) => /set_config\('app\.bypass_rls', 'on', true\)/.test(q))).toBe(true);
    });

    it("withTenantRlsScope sets app.current_tenant for a non-admin tenant", async () => {
      const { db, queries } = recordingPgClient();
      const ctx: TenantContext = {
        tenantId: TENANT_A,
        apiKeyId: "k1",
        role: "developer",
        rateLimitRpm: 60
      };
      await withTenantRlsScope(db, ctx, async () => "ok");
      expect(queries.some((q) => /set_config\('app\.current_tenant', \$1, true\)/.test(q))).toBe(true);
      // A non-admin must NOT get the cross-tenant bypass.
      expect(queries.some((q) => /app\.bypass_rls/.test(q))).toBe(false);
    });

    it("withTenantRlsScope grants admin the cross-tenant bypass", async () => {
      const { db, queries } = recordingPgClient();
      const ctx: TenantContext = {
        tenantId: TENANT_A,
        apiKeyId: "k1",
        role: "admin",
        rateLimitRpm: 60
      };
      await withTenantRlsScope(db, ctx, async () => "ok");
      expect(queries.some((q) => /app\.bypass_rls/.test(q))).toBe(true);
    });
  });

  describe("migration 0025 structure", () => {
    const sql = readFileSync(
      fileURLToPath(new URL("../db/migrations/0025_tenant_scope_replay_sideeffects.sql", import.meta.url)),
      "utf8"
    );

    const gapTables = [
      "replay_sessions",
      "replay_snapshots",
      "replay_branches",
      "failure_signals",
      "execution_checkpoints",
      "replay_certifications",
      "event_outbox",
      "event_outbox_dlq"
    ];

    it("adds a tenant_id column to every gap table", () => {
      for (const t of gapTables) {
        const re = new RegExp(`alter table ${t}\\b[\\s\\S]*?tenant_id text not null default 'system'`);
        expect(re.test(sql), `expected tenant_id column on ${t}`).toBe(true);
      }
    });

    it("is idempotent (add column / index / policy guards)", () => {
      expect(sql).toMatch(/add column if not exists/);
      expect(sql).toMatch(/create index if not exists/);
      expect(sql).toMatch(/drop policy if exists tenant_isolation/);
    });

    it("ships RLS in the same non-breaking transparent-when-unset mode as 0024", () => {
      // Transparent clause: permit when no tenant context is set.
      expect(sql).toMatch(/app_current_tenant\(\) is null/);
      expect(sql).toMatch(/tenant_id = app_current_tenant\(\)/);
      expect(sql).toMatch(/create policy tenant_isolation/);
      // Every gap table must be enrolled in the RLS DO block.
      for (const t of gapTables) {
        expect(sql.includes(`'${t}'`), `expected ${t} in RLS scoped_tables`).toBe(true);
      }
    });

    it("documents the STRICT flip as a manual step, not an auto-running migration", () => {
      expect(sql).toMatch(/STRICT MODE/);
      expect(sql.toLowerCase()).toMatch(/not an auto-running migration|documented manual step/);
    });
  });
});
