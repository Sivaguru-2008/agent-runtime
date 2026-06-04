/**
 * Funnel alerts — unit suite.
 *
 * Asserts the firing/ok decision logic, the disabled/null short-circuits, and
 * the one-shot `changed` flag using a stateful fake that models funnel_alert_state
 * (status read + the fired_at transition the ON CONFLICT performs). The real SQL
 * transition is additionally proven in the Postgres integration suite.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateFunnelAlerts,
  DEFAULT_ALERT_CONFIG,
  type FunnelAlertConfig
} from "../src/application/analytics/funnelAlerts.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";

interface AlertInputs {
  rate: { signups: number; activated: number };
  lastSignupAt: string | null;
}

// Stateful fake: serves the rate + gap queries from a mutable inputs ref and
// models funnel_alert_state (status select + fired_at-computing upsert).
function alertDb(inputs: { current: AlertInputs }): PgClient {
  const state = new Map<string, { status: string; firedAt: string | null }>();
  const run = async (sql: string, params: unknown[] = []) => {
    const t = sql.toLowerCase();
    if (t.includes("max(occurred_at) as last_signup_at")) {
      return { rows: [{ last_signup_at: inputs.current.lastSignupAt }], rowCount: 1 };
    }
    if (t.includes("left join funnel_events a") && t.includes("occurred_at >= $1")) {
      return { rows: [{ signups: inputs.current.rate.signups, activated: inputs.current.rate.activated }], rowCount: 1 };
    }
    if (t.includes("select status from funnel_alert_state")) {
      const r = state.get(String(params[0]));
      return { rows: r ? [{ status: r.status }] : [], rowCount: r ? 1 : 0 };
    }
    if (t.includes("insert into funnel_alert_state")) {
      const ruleId = String(params[0]);
      const status = String(params[1]);
      const prev = state.get(ruleId);
      let firedAt: string | null = null;
      if (status === "firing") firedAt = prev?.status === "firing" ? prev.firedAt : new Date().toISOString();
      state.set(ruleId, { status, firedAt });
      return { rows: [{ fired_at: firedAt }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const db: PgClient = {
    query: (async (sql: string, params: unknown[] = []) => run(sql, params)) as PgClient["query"],
    async withTransaction(fn) { return fn(db); },
    async acquire() { return { query: (async (s: string, p: unknown[] = []) => run(s, p)) as never, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  };
  return db;
}

const CONFIG: FunnelAlertConfig = {
  enabled: true,
  minActivationRate: 0.2,
  activationWindowDays: 7,
  minSample: 10,
  maxSignupGapHours: 48
};

const recently = () => new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

describe("evaluateFunnelAlerts — short circuits", () => {
  it("returns disabled + empty when alerts are off", async () => {
    const r = await evaluateFunnelAlerts(alertDb({ current: { rate: { signups: 0, activated: 0 }, lastSignupAt: null } }), { ...CONFIG, enabled: false });
    expect(r.enabled).toBe(false);
    expect(r.alerts).toEqual([]);
  });
  it("returns disabled + empty for a null db", async () => {
    const r = await evaluateFunnelAlerts(null, CONFIG);
    expect(r.enabled).toBe(false);
    expect(r.alerts).toEqual([]);
  });
});

describe("low_activation_rate rule", () => {
  it("fires when rate is below floor with enough sample", async () => {
    const db = alertDb({ current: { rate: { signups: 20, activated: 2 }, lastSignupAt: recently() } });
    const r = await evaluateFunnelAlerts(db, CONFIG);
    const rule = r.alerts.find((a) => a.ruleId === "low_activation_rate")!;
    expect(rule.status).toBe("firing");
    expect(rule.value).toBeCloseTo(0.1, 6);
    expect(rule.changed).toBe(true);
    expect(rule.firedAt).not.toBeNull();
  });

  it("stays ok when the sample is too small to judge", async () => {
    const db = alertDb({ current: { rate: { signups: 3, activated: 0 }, lastSignupAt: recently() } });
    const r = await evaluateFunnelAlerts(db, CONFIG);
    const rule = r.alerts.find((a) => a.ruleId === "low_activation_rate")!;
    expect(rule.status).toBe("ok");
    expect(rule.reason).toMatch(/need 10/);
  });

  it("stays ok when rate is at/above the floor", async () => {
    const db = alertDb({ current: { rate: { signups: 20, activated: 10 }, lastSignupAt: recently() } });
    const r = await evaluateFunnelAlerts(db, CONFIG);
    expect(r.alerts.find((a) => a.ruleId === "low_activation_rate")!.status).toBe("ok");
  });
});

describe("signup_gap rule", () => {
  it("fires when the last signup is older than the threshold", async () => {
    const stale = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(); // 100h ago
    const db = alertDb({ current: { rate: { signups: 20, activated: 10 }, lastSignupAt: stale } });
    const r = await evaluateFunnelAlerts(db, CONFIG);
    const rule = r.alerts.find((a) => a.ruleId === "signup_gap")!;
    expect(rule.status).toBe("firing");
    expect(rule.value).toBeGreaterThan(48);
  });

  it("stays ok with no signups at all (new deployment)", async () => {
    const db = alertDb({ current: { rate: { signups: 0, activated: 0 }, lastSignupAt: null } });
    const r = await evaluateFunnelAlerts(db, CONFIG);
    expect(r.alerts.find((a) => a.ruleId === "signup_gap")!.status).toBe("ok");
  });
});

describe("debounce (changed flag)", () => {
  it("reports changed once on entering firing, then false while it persists", async () => {
    const inputs = { current: { rate: { signups: 20, activated: 2 }, lastSignupAt: recently() } };
    const db = alertDb(inputs);

    const first = await evaluateFunnelAlerts(db, CONFIG);
    expect(first.alerts.find((a) => a.ruleId === "low_activation_rate")!.changed).toBe(true);

    const second = await evaluateFunnelAlerts(db, CONFIG);
    const rule2 = second.alerts.find((a) => a.ruleId === "low_activation_rate")!;
    expect(rule2.status).toBe("firing");
    expect(rule2.changed).toBe(false); // still firing → no new transition

    // Recover: rate climbs above the floor.
    inputs.current.rate = { signups: 20, activated: 12 };
    const third = await evaluateFunnelAlerts(db, CONFIG);
    const rule3 = third.alerts.find((a) => a.ruleId === "low_activation_rate")!;
    expect(rule3.status).toBe("ok");
    expect(rule3.changed).toBe(true); // firing → ok transition
  });
});

describe("DEFAULT_ALERT_CONFIG", () => {
  it("is off by default", () => {
    expect(DEFAULT_ALERT_CONFIG.enabled).toBe(false);
  });
});
