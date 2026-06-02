/**
 * RBAC migration (0026_rbac_roles.sql) — Postgres contract.
 *
 * Proves against a REAL Postgres (testcontainer or external) what the unit
 * suite can only assert in memory:
 *
 *   1. role_permissions in the DB matches the code matrix in permissions.ts
 *      EXACTLY — no drift between the enforced capability set and the queryable
 *      forensic snapshot.
 *   2. The api_keys role CHECK constraint accepts all six canonical roles and
 *      rejects the legacy "readonly" label and any junk role.
 *   3. The migration's legacy rewrite (readonly → viewer) + constraint swap is
 *      idempotent: re-applying 0026 over a DB that still holds a "readonly" row
 *      rewrites it to "viewer" and leaves the constraint rejecting "readonly".
 *
 * Skips cleanly (single line) when neither Docker nor INTEGRATION_DATABASE_URL
 * is available — same contract as every other *.integration.test.ts here.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tryStartHarness } from "./harness.js";
import {
  ROLE_PERMISSIONS,
  type Permission
} from "../../../src/infrastructure/security/permissions.js";
import type { ApiKeyRole } from "../../../src/infrastructure/security/tenantContext.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_0026 = resolve(HERE, "..", "..", "..", "db", "migrations", "0026_rbac_roles.sql");

const ROLES: ApiKeyRole[] = ["owner", "admin", "operator", "developer", "auditor", "viewer"];

const harness = await tryStartHarness();

afterAll(async () => {
  if (harness) await harness.stop();
});

// Insert a key row for `role`, returning the DB error (if the CHECK rejects it).
async function tryInsertKey(role: string): Promise<{ ok: boolean; error?: string }> {
  const suffix = `${role}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await harness!.pg.query(
      `insert into api_keys (id, tenant_id, name, key_hash, key_prefix, role)
       values ($1, 'system', $2, $3, $4, $5)`,
      [`k-${suffix}`, `rbac-test-${suffix}`, `hash-${suffix}`, "sk_live_test", role]
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

describe.skipIf(!harness)("RBAC migration 0026 — Postgres contract", () => {
  it("role_permissions matches the code matrix exactly (no drift)", async () => {
    const { rows } = await harness!.pg.query<{ role: string; permission: string }>(
      "select role, permission from role_permissions"
    );

    // Build {role -> Set<permission>} from the DB and compare to the code matrix.
    const fromDb = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!fromDb.has(r.role)) fromDb.set(r.role, new Set());
      fromDb.get(r.role)!.add(r.permission);
    }

    for (const role of ROLES) {
      const expected = [...ROLE_PERMISSIONS[role]].sort();
      const actual = [...(fromDb.get(role) ?? new Set<Permission>())].sort();
      expect(actual, `permissions for role '${role}'`).toEqual(expected);
    }
    // No extra roles snuck into the table.
    expect([...fromDb.keys()].sort()).toEqual([...ROLES].sort());
  });

  it("accepts all six canonical roles", async () => {
    for (const role of ROLES) {
      const res = await tryInsertKey(role);
      expect(res.ok, `insert role '${role}' → ${res.error ?? "ok"}`).toBe(true);
    }
  });

  it("rejects the legacy 'readonly' label and junk roles", async () => {
    const legacy = await tryInsertKey("readonly");
    expect(legacy.ok).toBe(false);
    expect(legacy.error).toMatch(/api_keys_role_check|check constraint/i);

    const junk = await tryInsertKey("superuser");
    expect(junk.ok).toBe(false);
  });

  it("re-applying the migration rewrites a residual 'readonly' row to 'viewer' (idempotent)", async () => {
    // Simulate a pre-migration row: drop the constraint, insert 'readonly',
    // then replay the whole 0026 migration file. Its UPDATE must rewrite the
    // row and its constraint swap must reject 'readonly' again — all without
    // error (drop-if-exists + truncate make it idempotent).
    await harness!.pg.query("alter table api_keys drop constraint if exists api_keys_role_check");
    await harness!.pg.query(
      `insert into api_keys (id, tenant_id, name, key_hash, key_prefix, role)
       values ('k-legacy-ro', 'system', 'legacy-readonly', 'hash-legacy-ro', 'sk_live_test', 'readonly')`
    );

    const migrationSql = await readFile(MIGRATION_0026, "utf8");
    await harness!.pg.query(migrationSql); // must not throw

    const { rows } = await harness!.pg.query<{ role: string }>(
      "select role from api_keys where id = 'k-legacy-ro'"
    );
    expect(rows[0]?.role).toBe("viewer");

    // Constraint is back in force.
    expect((await tryInsertKey("readonly")).ok).toBe(false);
  });
});
