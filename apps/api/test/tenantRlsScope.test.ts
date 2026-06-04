/**
 * Verifies the RLS session-scope wiring primitive emits the correct
 * transaction-local GUCs so the database-enforced tenant policies
 * (migration 0024) activate, and that the admin bypass is honored.
 */

import { describe, it, expect } from "vitest";
import { withTenantRlsScope, scopeFromContext } from "../src/infrastructure/security/tenantRlsScope.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";
import type { TenantContext } from "../src/infrastructure/security/tenantContext.js";

function recordingDb(): PgClient & { sql: Array<{ text: string; params?: unknown[] }> } {
  const sql: Array<{ text: string; params?: unknown[] }> = [];
  const client: PgClient & { sql: typeof sql } = {
    sql,
    async query(text: string, params?: unknown[]) {
      sql.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
    async withTransaction<T>(fn: (tx: PgClient) => Promise<T>) {
      // Reuse the same recording client as the transaction handle.
      return fn(client);
    },
    async acquire() {
      return { async query() { return { rows: [], rowCount: 0 }; }, release() {} };
    },
    stats() {
      return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 };
    },
    async close() {}
  };
  return client;
}

describe("withTenantRlsScope", () => {
  it("sets the tenant GUC transaction-locally before running the callback", async () => {
    const db = recordingDb();
    const result = await withTenantRlsScope(db, { tenantId: "tenant-A" }, async (tx) => {
      await tx.query("select 1 from executions");
      return "done";
    });
    expect(result).toBe("done");
    expect(db.sql[0]).toEqual({
      text: "select set_config('app.current_tenant', $1, true)",
      params: ["tenant-A"]
    });
    // No bypass for a plain (non-admin) scope.
    expect(db.sql.some((q) => q.text.includes("app.bypass_rls"))).toBe(false);
    expect(db.sql.at(-1)?.text).toBe("select 1 from executions");
  });

  it("enables the RLS bypass for admin contexts only", async () => {
    const adminDb = recordingDb();
    const admin: TenantContext = { tenantId: "tenant-A", apiKeyId: "k", role: "admin", rateLimitRpm: 1 };
    expect(scopeFromContext(admin)).toEqual({ tenantId: "tenant-A", bypass: true });
    await withTenantRlsScope(adminDb, admin, async () => undefined);
    expect(adminDb.sql.some((q) => q.text === "select set_config('app.bypass_rls', 'on', true)")).toBe(true);

    const devDb = recordingDb();
    const dev: TenantContext = { tenantId: "tenant-A", apiKeyId: "k", role: "developer", rateLimitRpm: 1 };
    expect(scopeFromContext(dev)).toEqual({ tenantId: "tenant-A", bypass: false });
    await withTenantRlsScope(devDb, dev, async () => undefined);
    expect(devDb.sql.some((q) => q.text.includes("app.bypass_rls"))).toBe(false);
  });
});
