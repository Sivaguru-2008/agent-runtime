/**
 * Phase 2 funnel analytics routes (admin-gated, tenant:read).
 *
 * These layer cohort analysis, segmentation, period-over-period comparison,
 * data-quality/pipeline health, and threshold alerts on top of the Phase 1
 * funnel_events log. They live in their own plugin (registered from app.ts)
 * rather than signupRoutes.ts to keep the signup write path lean; the Phase 1
 * /admin/funnel and /admin/funnel/history endpoints remain in signupRoutes.ts.
 *
 * Every route is gated by `tenant:read` (same posture as /admin/funnel) and
 * tolerates a null db (MEMORY mode) by returning well-formed empty results.
 */

import type { FastifyInstance } from "fastify";
import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";
import { requirePermission } from "../../infrastructure/security/rbac.js";
import {
  cohortFunnel,
  coerceCohortGranularity,
  segmentedFunnel,
  isSegmentDimension,
  periodComparison,
  funnelHealth,
  retentionCurve
} from "../../application/analytics/funnelAnalytics.js";
import {
  evaluateFunnelAlerts,
  type FunnelAlertConfig
} from "../../application/analytics/funnelAlerts.js";
import { refreshFunnelDaily } from "../../application/analytics/funnelRollup.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseIntParam(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export async function registerFunnelAnalyticsRoutes(
  app: FastifyInstance,
  db: PgClient | null,
  alertConfig: FunnelAlertConfig
): Promise<void> {
  // Cohort activation triangle. Defaults: weekly cohorts, 8 offset columns,
  // lookback wide enough to surface ~12 recent cohorts.
  app.get("/admin/funnel/cohorts", { preHandler: requirePermission("tenant:read") }, async (request) => {
    const q = (request.query ?? {}) as { cohortBy?: string; periods?: string; from?: string };
    const cohortBy = coerceCohortGranularity(q.cohortBy);
    const periods = Math.max(1, Math.min(52, parseIntParam(q.periods, 8)));
    const lookbackDays = cohortBy === "month" ? 365 : 84;
    const from = parseDate(q.from) ?? new Date(Date.now() - lookbackDays * DAY_MS);
    return cohortFunnel(db, { cohortBy, periods, from });
  });

  // All-time funnel sliced by a dimension. Unknown dimension → 400.
  app.get("/admin/funnel/segments", { preHandler: requirePermission("tenant:read") }, async (request, reply) => {
    const q = (request.query ?? {}) as { segmentBy?: string };
    const segmentBy = q.segmentBy ?? "source";
    if (!isSegmentDimension(segmentBy)) {
      return reply.status(400).send({
        error: "INVALID_SEGMENT",
        message: "segmentBy must be one of: source, plan, invite, campaign."
      });
    }
    return segmentedFunnel(db, segmentBy);
  });

  // Current (in-progress) vs previous (complete) period.
  app.get("/admin/funnel/compare", { preHandler: requirePermission("tenant:read") }, async (request) => {
    const q = (request.query ?? {}) as { granularity?: string };
    const granularity = q.granularity === "month" ? "month" : "week";
    return periodComparison(db, granularity);
  });

  // Pipeline freshness + data-quality invariants.
  app.get("/admin/funnel/health", { preHandler: requirePermission("tenant:read") }, async () => {
    return funnelHealth(db);
  });

  // Threshold alerts. Evaluated + persisted on read; transitions are logged
  // once via the request logger.
  app.get("/admin/funnel/alerts", { preHandler: requirePermission("tenant:read") }, async (request) => {
    return evaluateFunnelAlerts(db, alertConfig, { logger: request.log });
  });

  // Retention curve: of each signup cohort, the fraction still active in each
  // subsequent period (non-cumulative). Defaults: weekly cohorts, 8 periods.
  app.get("/admin/funnel/retention", { preHandler: requirePermission("tenant:read") }, async (request) => {
    const q = (request.query ?? {}) as { cohortBy?: string; periods?: string; from?: string };
    const cohortBy = coerceCohortGranularity(q.cohortBy);
    const periods = Math.max(1, Math.min(52, parseIntParam(q.periods, 8)));
    const lookbackDays = cohortBy === "month" ? 365 : 84;
    const from = parseDate(q.from) ?? new Date(Date.now() - lookbackDays * DAY_MS);
    return retentionCurve(db, { cohortBy, periods, from });
  });

  // Recompute the funnel_daily rollup (Phase 3 scale path). Admin-gated write;
  // safe to call repeatedly (idempotent upsert). Meant for a scheduler/cron.
  app.post("/admin/funnel/rollup/refresh", { preHandler: requirePermission("tenant:read") }, async () => {
    return refreshFunnelDaily(db);
  });

  // CSV export of the signup lead list + activation status. Admin-gated.
  // Streams text/csv with a download filename; values are quote-escaped.
  app.get("/admin/funnel/export", { preHandler: requirePermission("tenant:read") }, async (_request, reply) => {
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="funnel-signups-${new Date().toISOString().slice(0, 10)}.csv"`);
    const header = "email,tenant_id,plan,source,invite_code,created_at,activated_at,activated\n";
    if (!db) return header;
    const { rows } = await db.query<{
      email: string;
      tenant_id: string;
      plan: string | null;
      source_norm: string | null;
      invite_code: string | null;
      created_at: Date | string;
      activated_at: Date | string | null;
    }>(
      `select s.email, s.tenant_id, t.plan, s.source_norm, s.invite_code,
              s.created_at, s.activated_at
         from signups s
         join tenants t on t.id = s.tenant_id
        order by s.created_at desc
        limit 100000`
    );
    const iso = (v: Date | string | null) =>
      v == null ? "" : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
    const body = rows
      .map((r) =>
        [
          r.email,
          r.tenant_id,
          r.plan ?? "",
          r.source_norm ?? "direct",
          r.invite_code ?? "",
          iso(r.created_at),
          iso(r.activated_at),
          r.activated_at ? "true" : "false"
        ]
          .map(csvCell)
          .join(",")
      )
      .join("\n");
    return header + body + (body ? "\n" : "");
  });
}

/** RFC-4180 cell escaping: wrap in quotes and double internal quotes when the
 *  value contains a comma, quote, or newline. */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
