/**
 * Funnel threshold alerts (Phase 2, capability 11).
 *
 * Evaluates a small set of business-critical funnel rules and persists each
 * rule's status in funnel_alert_state (migration 0031) so transitions are
 * detected exactly once (debounce) across evaluations. Designed to be driven
 * by polling GET /admin/funnel/alerts (the operator dashboard polls it; a cron
 * or future scheduler tick can poll it too) — there is no background timer, so
 * nothing here touches the determinism clock or the cluster scheduler.
 *
 * Rules:
 *   • low_activation_rate — over a trailing window, if the cohort is large
 *     enough (minSample) and its activation rate is below the floor, fire.
 *     A window with too few signups is NOT an emergency → stays ok.
 *   • signup_gap — if the most recent signup is older than maxSignupGapHours,
 *     fire. No signups at all (brand-new deployment) → stays ok.
 *
 * Fail-safe posture: a broken db must not 500 the dashboard. The evaluator
 * catches per-rule query errors and reports that rule as ok with an error
 * reason rather than throwing.
 */

import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";

export interface FunnelAlertConfig {
  enabled: boolean;
  /** Activation-rate floor, 0..1. Below this (with enough sample) → firing. */
  minActivationRate: number;
  /** Trailing window (days) the activation-rate rule measures over. */
  activationWindowDays: number;
  /** Minimum signups in the window before the activation-rate rule can fire. */
  minSample: number;
  /** Max hours since the last signup before signup_gap fires. */
  maxSignupGapHours: number;
}

export const DEFAULT_ALERT_CONFIG: FunnelAlertConfig = {
  enabled: false,
  minActivationRate: 0.2,
  activationWindowDays: 7,
  minSample: 10,
  maxSignupGapHours: 48
};

export type AlertStatus = "ok" | "firing";

export interface FunnelAlertEvaluation {
  ruleId: string;
  title: string;
  status: AlertStatus;
  /** The measured value (rate or hours), null when not computable. */
  value: number | null;
  threshold: number | null;
  reason: string;
  /** When the rule most recently entered firing (ISO), null while ok. */
  firedAt: string | null;
  /** True when status changed vs the persisted state (drives one-shot logging). */
  changed: boolean;
}

export interface FunnelAlertsResult {
  enabled: boolean;
  evaluatedAt: string;
  alerts: FunnelAlertEvaluation[];
}

interface AlertLogger {
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  info: (obj: Record<string, unknown>, msg?: string) => void;
}

interface RuleOutcome {
  status: AlertStatus;
  value: number | null;
  threshold: number | null;
  reason: string;
}

/**
 * Persist a rule's outcome and return whether the status changed and the
 * current fired_at. Transitions (fired_at / recovered_at) are computed in SQL
 * so concurrent evaluations stay consistent.
 */
async function persist(
  db: PgClient,
  ruleId: string,
  o: RuleOutcome
): Promise<{ changed: boolean; firedAt: string | null }> {
  const { rows: prevRows } = await db.query<{ status: string }>(
    `select status from funnel_alert_state where rule_id = $1`,
    [ruleId]
  );
  const prevStatus = prevRows[0]?.status ?? "ok";
  const changed = prevStatus !== o.status;

  const { rows } = await db.query<{ fired_at: Date | string | null }>(
    `insert into funnel_alert_state (rule_id, status, last_value, threshold, detail, fired_at, recovered_at, updated_at)
     values ($1, $2, $3, $4, $5::jsonb,
             case when $2 = 'firing' then now() else null end, null, now())
     on conflict (rule_id) do update set
       status = excluded.status,
       last_value = excluded.last_value,
       threshold = excluded.threshold,
       detail = excluded.detail,
       fired_at = case
         when excluded.status = 'firing' and funnel_alert_state.status <> 'firing' then now()
         when excluded.status = 'firing' then funnel_alert_state.fired_at
         else null end,
       recovered_at = case
         when excluded.status = 'ok' and funnel_alert_state.status = 'firing' then now()
         when excluded.status = 'ok' then funnel_alert_state.recovered_at
         else null end,
       updated_at = now()
     returning fired_at`,
    [ruleId, o.status, o.value, o.threshold, JSON.stringify({ reason: o.reason })]
  );
  const firedAt = rows[0]?.fired_at ?? null;
  return {
    changed,
    firedAt: firedAt instanceof Date ? firedAt.toISOString() : firedAt ? String(firedAt) : null
  };
}

async function evaluateActivationRate(db: PgClient, config: FunnelAlertConfig): Promise<RuleOutcome> {
  const since = new Date(Date.now() - config.activationWindowDays * 24 * 60 * 60 * 1000);
  const { rows } = await db.query<{ signups: number | string; activated: number | string }>(
    `select count(*)::int as signups,
            count(a.tenant_id)::int as activated
       from funnel_events s
       left join funnel_events a
         on a.tenant_id = s.tenant_id and a.event_type = 'activation'
      where s.event_type = 'signup'
        and s.occurred_at >= $1`,
    [since]
  );
  const signups = Number(rows[0]?.signups ?? 0);
  const activated = Number(rows[0]?.activated ?? 0);
  const rate = signups > 0 ? activated / signups : 0;
  const threshold = config.minActivationRate;

  if (signups < config.minSample) {
    return {
      status: "ok",
      value: signups > 0 ? rate : null,
      threshold,
      reason: `Only ${signups} signups in the last ${config.activationWindowDays}d (need ${config.minSample} to evaluate).`
    };
  }
  if (rate < threshold) {
    return {
      status: "firing",
      value: rate,
      threshold,
      reason: `Activation rate ${(rate * 100).toFixed(0)}% over ${config.activationWindowDays}d is below the ${(threshold * 100).toFixed(0)}% floor (${activated}/${signups}).`
    };
  }
  return {
    status: "ok",
    value: rate,
    threshold,
    reason: `Activation rate ${(rate * 100).toFixed(0)}% (${activated}/${signups}) is healthy.`
  };
}

async function evaluateSignupGap(db: PgClient, config: FunnelAlertConfig): Promise<RuleOutcome> {
  const { rows } = await db.query<{ last_signup_at: Date | string | null }>(
    `select max(occurred_at) as last_signup_at from funnel_events where event_type = 'signup'`
  );
  const last = rows[0]?.last_signup_at ?? null;
  const threshold = config.maxSignupGapHours;
  if (!last) {
    return { status: "ok", value: null, threshold, reason: "No signups recorded yet." };
  }
  const hours = (Date.now() - new Date(last).getTime()) / (60 * 60 * 1000);
  if (hours > threshold) {
    return {
      status: "firing",
      value: hours,
      threshold,
      reason: `No new signup in ${hours.toFixed(1)}h (threshold ${threshold}h).`
    };
  }
  return {
    status: "ok",
    value: hours,
    threshold,
    reason: `Last signup ${hours.toFixed(1)}h ago.`
  };
}

const RULES: Array<{
  ruleId: string;
  title: string;
  evaluate: (db: PgClient, config: FunnelAlertConfig) => Promise<RuleOutcome>;
}> = [
  { ruleId: "low_activation_rate", title: "Low activation rate", evaluate: evaluateActivationRate },
  { ruleId: "signup_gap", title: "Signup gap", evaluate: evaluateSignupGap }
];

/**
 * Evaluate all funnel alert rules, persist their state, and return the current
 * status of each. When disabled or in MEMORY mode, returns an empty, disabled
 * result. Per-rule failures degrade to an `ok` with an error reason rather than
 * propagating — the dashboard must never 500 because an alert query failed.
 */
export async function evaluateFunnelAlerts(
  db: PgClient | null,
  config: FunnelAlertConfig,
  opts: { logger?: AlertLogger } = {}
): Promise<FunnelAlertsResult> {
  const evaluatedAt = new Date().toISOString();
  if (!config.enabled || !db) {
    return { enabled: config.enabled && !!db, evaluatedAt, alerts: [] };
  }

  const alerts: FunnelAlertEvaluation[] = [];
  for (const rule of RULES) {
    try {
      const outcome = await rule.evaluate(db, config);
      const { changed, firedAt } = await persist(db, rule.ruleId, outcome);
      if (changed && opts.logger) {
        const line = { ruleId: rule.ruleId, status: outcome.status, value: outcome.value, reason: outcome.reason };
        if (outcome.status === "firing") opts.logger.warn(line, `[funnel-alert] ${rule.ruleId} FIRING`);
        else opts.logger.info(line, `[funnel-alert] ${rule.ruleId} recovered`);
      }
      alerts.push({
        ruleId: rule.ruleId,
        title: rule.title,
        status: outcome.status,
        value: outcome.value,
        threshold: outcome.threshold,
        reason: outcome.reason,
        firedAt,
        changed
      });
    } catch (err) {
      // Fail-safe: a broken rule reports ok-with-reason, never throws.
      alerts.push({
        ruleId: rule.ruleId,
        title: rule.title,
        status: "ok",
        value: null,
        threshold: null,
        reason: `Evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        firedAt: null,
        changed: false
      });
    }
  }
  return { enabled: true, evaluatedAt, alerts };
}
