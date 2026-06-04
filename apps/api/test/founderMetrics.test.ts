/**
 * Founder metrics suite — proves the activation-funnel math (stage conversions,
 * signup/activation/retention rates, biggest drop-off) and the overview shape,
 * driven by a canned fake PgClient that returns fixed aggregate rows.
 */

import { describe, expect, it } from "vitest";
import {
  activationFunnel,
  founderOverview,
  userDirectory
} from "../src/application/analytics/founderMetrics.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";

function cannedDb(handler: (sql: string, params: unknown[]) => any[]): PgClient {
  const run = async (sql: string, params: unknown[] = []) => ({ rows: handler(sql, params), rowCount: 0 });
  const db: PgClient = {
    query: (async (sql: string, params: unknown[] = []) => run(sql, params)) as PgClient["query"],
    async withTransaction(fn) { return fn(db); },
    async acquire() { return { query: (async (s: string, p: unknown[] = []) => run(s, p)) as never, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  };
  return db;
}

describe("activationFunnel", () => {
  it("computes stage conversions, rates, and the biggest drop-off", async () => {
    // The prompt's worked example: 100 visitors → 20 signups → 12 agents → 6 tasks.
    const db = cannedDb((sql) => {
      if (sql.toLowerCase().includes("as visitors")) {
        return [{
          visitors: 100, signups: 20, logins: 20, returning: 5,
          dev_keys: 16, agents: 12, tasks: 6, replays: 3
        }];
      }
      return [];
    });

    const funnel = await activationFunnel(db);
    expect(funnel.stages).toHaveLength(7);
    expect(funnel.stages[0]).toMatchObject({ stage: "Visitors", count: 100 });
    expect(funnel.stages[1]).toMatchObject({ stage: "Signups", count: 20 });

    // signups/visitors
    expect(funnel.signupRate).toBeCloseTo(0.2, 5);
    // tasks/signups
    expect(funnel.activationRate).toBeCloseTo(6 / 20, 5);
    // returning/signups
    expect(funnel.retentionRate).toBeCloseTo(5 / 20, 5);

    // Overall conversion of the last stage relative to visitors.
    const replays = funnel.stages.find((s) => s.stage === "Replays Viewed")!;
    expect(replays.overallConversion).toBeCloseTo(3 / 100, 5);

    // Biggest drop is Visitors → Signups (80% lost).
    expect(funnel.biggestDropOff).not.toBeNull();
    expect(funnel.biggestDropOff!.from).toBe("Visitors");
    expect(funnel.biggestDropOff!.to).toBe("Signups");
    expect(funnel.biggestDropOff!.lostPct).toBeCloseTo(0.8, 5);
  });

  it("never divides by zero with an empty platform", async () => {
    const db = cannedDb(() => [{ visitors: 0, signups: 0, logins: 0, returning: 0, dev_keys: 0, agents: 0, tasks: 0, replays: 0 }]);
    const funnel = await activationFunnel(db);
    expect(funnel.signupRate).toBe(0);
    expect(funnel.activationRate).toBe(0);
    expect(funnel.retentionRate).toBe(0);
  });
});

describe("founderOverview", () => {
  it("maps the scalar block, active windows, and recent feed", async () => {
    const db = cannedDb((sql) => {
      const t = sql.toLowerCase();
      if (t.includes("as total_users")) {
        return [{
          total_users: 42, new_today: 3, new_week: 10, total_logins: 99,
          dev_keys: 20, agents: 15, tasks: 8, replays: 4
        }];
      }
      if (t.includes("w(window, span)")) {
        return [{ window: "24h", users: 5 }, { window: "7d", users: 12 }, { window: "30d", users: 30 }];
      }
      if (t.includes("from user_events e")) {
        return [{ event_type: "login", occurred_at: "2026-06-04T00:00:00Z", user_id: "u1", email: "a@x.com", name: "A" }];
      }
      return [];
    });

    const o = await founderOverview(db);
    expect(o.totalUsers).toBe(42);
    expect(o.newUsersToday).toBe(3);
    expect(o.newUsersThisWeek).toBe(10);
    expect(o.totalLogins).toBe(99);
    expect(o.activeUsers24h).toBe(5);
    expect(o.activeUsers7d).toBe(12);
    expect(o.activeUsers30d).toBe(30);
    expect(o.activation).toMatchObject({ developerKeysCreated: 20, agentsCreated: 15, tasksExecuted: 8, replaysViewed: 4 });
    expect(o.recentActivity).toHaveLength(1);
    expect(o.recentActivity[0]!.email).toBe("a@x.com");
  });
});

describe("userDirectory", () => {
  it("builds search/filter/sort SQL and maps rows", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const db = cannedDb((sql, params) => {
      const t = sql.toLowerCase();
      if (t.startsWith("select count(*)")) return [{ n: 1 }];
      capturedSql = sql;
      capturedParams = params;
      return [{
        user_id: "u1", name: "Ada", email: "ada@x.com", created_at: "2026-01-01T00:00:00Z",
        last_login_at: "2026-06-01T00:00:00Z", login_count: 7,
        developer_key_created: "2026-01-02T00:00:00Z", first_task_executed: "2026-01-03T00:00:00Z",
        agent_count: 4, task_count: 11
      }];
    });

    const result = await userDirectory(db, { search: "ada", filter: "activated", sort: "task_count", direction: "desc", limit: 10 });
    expect(result.total).toBe(1);
    expect(result.users).toHaveLength(1);
    expect(result.users[0]).toMatchObject({
      email: "ada@x.com", loginCount: 7, developerKeyCreated: true, agentCount: 4, taskCount: 11, activated: true
    });
    // Search param was bound and the activated filter applied.
    expect(capturedParams).toContain("%ada%");
    expect(capturedSql.toLowerCase()).toContain("first_task_executed is not null");
    expect(capturedSql.toLowerCase()).toContain("order by task_count desc");
  });
});
