/**
 * Unit suite for GET /executions tenant-scoped listing.
 *
 * The handler delegates to the pure `listExecutionsForTenant`, so these tests
 * drive that function directly with lightweight stubs. They lock in the
 * security-critical behaviour (a non-admin must NEVER see another tenant's
 * executions) plus the status/sort/limit contract, without standing up the
 * whole HTTP app.
 */
import { describe, expect, it, vi } from "vitest";
import {
  listExecutionsForTenant,
  type ExecutionListDeps
} from "../src/interfaces/http/routes.js";
import type { TenantContext } from "../src/infrastructure/security/tenantContext.js";
import type { Execution } from "../src/domain/model.js";

function exec(id: string, agentId: string, overrides: Partial<Execution> = {}): Execution {
  return {
    id,
    agentId,
    status: "COMPLETED",
    input: {},
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: overrides.startedAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function ctxFor(tenantId: string, role: TenantContext["role"] = "developer"): TenantContext {
  return { tenantId, apiKeyId: "k", role, rateLimitRpm: 1000 };
}

/**
 * Build stub deps. `owners` maps agentId → owning tenant (null = unresolvable).
 * `executions` maps agentId → that agent's executions.
 */
function buildDeps(
  owners: Record<string, string | null>,
  executions: Record<string, Execution[]>
): ExecutionListDeps & { listByAgent: ReturnType<typeof vi.fn> } {
  const listByAgent = vi.fn(async (agentId: string) => executions[agentId] ?? []);
  return {
    agents: { list: async () => Object.keys(owners).map((id) => ({ id })) },
    executions: { listByAgent },
    guard: {
      resolveAgentTenant: async (agentId: string) => owners[agentId] ?? null,
      assertOwnsAgent: async (ctx: TenantContext, agentId: string) => {
        const owner = owners[agentId];
        if (owner != null && owner !== ctx.tenantId) {
          throw new Error("CrossTenantAccess");
        }
      }
    },
    listByAgent
  };
}

describe("listExecutionsForTenant — tenant scoping", () => {
  const owners = { agent_a: "tenant_1", agent_b: "tenant_2", agent_sys: null };
  const executions = {
    agent_a: [exec("e_a1", "agent_a")],
    agent_b: [exec("e_b1", "agent_b")],
    agent_sys: [exec("e_s1", "agent_sys")]
  };

  it("a non-admin sees only their own tenant's executions (plus ownerless)", async () => {
    const deps = buildDeps(owners, executions);
    const result = await listExecutionsForTenant(deps, ctxFor("tenant_1"), {});
    const ids = result.map((e) => e.id).sort();
    expect(ids).toEqual(["e_a1", "e_s1"]); // NOT e_b1
  });

  it("never reads another tenant's executions from the store", async () => {
    const deps = buildDeps(owners, executions);
    await listExecutionsForTenant(deps, ctxFor("tenant_1"), {});
    expect(deps.listByAgent).toHaveBeenCalledWith("agent_a");
    expect(deps.listByAgent).toHaveBeenCalledWith("agent_sys");
    expect(deps.listByAgent).not.toHaveBeenCalledWith("agent_b");
  });

  it("an admin sees every tenant's executions", async () => {
    const deps = buildDeps(owners, executions);
    const result = await listExecutionsForTenant(deps, ctxFor("tenant_1", "admin"), {});
    expect(result.map((e) => e.id).sort()).toEqual(["e_a1", "e_b1", "e_s1"]);
  });

  it("scopes to a single owned agent when agentId is supplied", async () => {
    const deps = buildDeps(owners, executions);
    const result = await listExecutionsForTenant(deps, ctxFor("tenant_1"), { agentId: "agent_a" });
    expect(result.map((e) => e.id)).toEqual(["e_a1"]);
    expect(deps.listByAgent).toHaveBeenCalledTimes(1);
  });

  it("rejects listing a single agent owned by another tenant", async () => {
    const deps = buildDeps(owners, executions);
    await expect(
      listExecutionsForTenant(deps, ctxFor("tenant_1"), { agentId: "agent_b" })
    ).rejects.toThrow(/CrossTenant/);
  });
});

describe("listExecutionsForTenant — filtering, sorting, limit", () => {
  const owners = { agent_a: "tenant_1" };

  it("returns newest first by startedAt", async () => {
    const executions = {
      agent_a: [
        exec("old", "agent_a", { startedAt: "2026-01-01T00:00:00.000Z" }),
        exec("new", "agent_a", { startedAt: "2026-03-01T00:00:00.000Z" }),
        exec("mid", "agent_a", { startedAt: "2026-02-01T00:00:00.000Z" })
      ]
    };
    const result = await listExecutionsForTenant(buildDeps(owners, executions), ctxFor("tenant_1"), {});
    expect(result.map((e) => e.id)).toEqual(["new", "mid", "old"]);
  });

  it("filters by a comma-separated status list", async () => {
    const executions = {
      agent_a: [
        exec("c", "agent_a", { status: "COMPLETED" }),
        exec("f", "agent_a", { status: "FAILED" }),
        exec("r", "agent_a", { status: "RUNNING" })
      ]
    };
    const result = await listExecutionsForTenant(buildDeps(owners, executions), ctxFor("tenant_1"), {
      status: "COMPLETED,FAILED"
    });
    expect(result.map((e) => e.id).sort()).toEqual(["c", "f"]);
  });

  it("applies the limit after sorting (keeps the newest)", async () => {
    const executions = {
      agent_a: [
        exec("old", "agent_a", { startedAt: "2026-01-01T00:00:00.000Z" }),
        exec("new", "agent_a", { startedAt: "2026-03-01T00:00:00.000Z" }),
        exec("mid", "agent_a", { startedAt: "2026-02-01T00:00:00.000Z" })
      ]
    };
    const result = await listExecutionsForTenant(buildDeps(owners, executions), ctxFor("tenant_1"), {
      limit: "2"
    });
    expect(result.map((e) => e.id)).toEqual(["new", "mid"]);
  });

  it("ignores a malformed limit", async () => {
    const executions = { agent_a: [exec("e1", "agent_a"), exec("e2", "agent_a")] };
    const result = await listExecutionsForTenant(buildDeps(owners, executions), ctxFor("tenant_1"), {
      limit: "not-a-number"
    });
    expect(result).toHaveLength(2);
  });

  it("returns an empty array when the caller owns no agents", async () => {
    const result = await listExecutionsForTenant(
      buildDeps({ agent_a: "tenant_1" }, { agent_a: [exec("e1", "agent_a")] }),
      ctxFor("tenant_other"),
      {}
    );
    expect(result).toEqual([]);
  });
});
