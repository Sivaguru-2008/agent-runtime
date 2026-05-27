/**
 * Quota Enforcer — per-tenant resource consumption limits.
 *
 * Production risk solved:
 *   Without quotas, a single tenant running a tight execution loop can saturate
 *   worker capacity and starve all other tenants. In SaaS deployments this is
 *   both a reliability risk and a billing risk (runaway cost accumulation).
 *
 * Architecture — two-layer enforcement:
 *   Layer 1 (Redis, ~1 ms): Hourly execution count and concurrent execution
 *     count are tracked in Redis INCR counters for sub-millisecond enforcement.
 *     Redis is authoritative for fast checks.
 *   Layer 2 (Postgres, ~5 ms): Agent count is verified against the DB because
 *     it is a monotonically growing table and Redis would require a full sync.
 *
 * Quota limits source:
 *   The tenant_quotas table stores per-tenant limits. Limits are cached in Redis
 *   for 5 minutes to avoid a DB hit on every request.
 *
 * Failure mode:
 *   Redis failure → quota checks fail open (allow the request). This prevents
 *   a Redis outage from blocking all executions. Postgres failure on agent count
 *   check also fails open for the same reason.
 *
 * Concurrent execution tracking:
 *   Callers MUST call trackExecutionEnd() when an execution completes or fails,
 *   otherwise the concurrent counter leaks. The counter has a safety TTL of 1 hour
 *   in Redis so leaked counts self-correct without manual intervention.
 *
 * Enterprise readiness:
 *   Limits are per-tenant and configurable in tenant_quotas without a deploy.
 *   The system tenant has effectively unlimited quotas.
 */

import type { Redis } from "ioredis";
import type { PgClient } from "../persistence/postgres/pgClient.js";

export interface QuotaLimits {
  maxExecutionsPerHour: number;
  maxEventsPerDay: number;
  maxConcurrentExecutions: number;
  maxAgents: number;
}

export interface QuotaResult {
  allowed: boolean;
  reason?: string;
  limit?: number;
  current?: number;
}

const DEFAULT_LIMITS: QuotaLimits = {
  maxExecutionsPerHour: 100,
  maxEventsPerDay: 100_000,
  maxConcurrentExecutions: 10,
  maxAgents: 50
};

const LIMITS_CACHE_TTL_SEC = 300; // 5 minutes
const CONCURRENT_SAFETY_TTL_SEC = 3600; // 1 hour safety cap

export class QuotaEnforcer {
  constructor(
    private readonly redis: Redis | null,
    private readonly db: PgClient,
    private readonly enabled: boolean
  ) {}

  /**
   * Check whether a new execution can start for this tenant.
   *
   * C-3 atomic reservation semantics:
   *   The previous implementation split the concurrent check from the
   *   increment (checkExecutionStart() read, then trackExecutionStart()
   *   wrote). Under burst concurrency two callers could both observe
   *   `concurrent == limit - 1`, both pass the check, and both then
   *   increment past the limit — the classic TOCTOU race.
   *
   *   We now INCR first (the only atomic step Redis offers), then validate
   *   the post-increment value against the limit. If the limit is exceeded
   *   we DECR back to the pre-call value so the counter never permanently
   *   drifts. The hourly counter follows the same pattern, unchanged from
   *   before. Callers MUST still call trackExecutionEnd() on completion so
   *   the concurrent counter drops back to zero.
   *
   *   Callers that previously called checkExecutionStart() AND then
   *   trackExecutionStart() should drop the second call — checkExecutionStart()
   *   now reserves the slot atomically when it returns { allowed: true }.
   */
  async checkExecutionStart(tenantId: string): Promise<QuotaResult> {
    if (!this.enabled) return { allowed: true };

    const limits = await this.getLimits(tenantId);

    if (this.redis) {
      // ── Atomic concurrent reservation (TOCTOU-safe) ────────────────────
      const concKey = this.concurrentKey(tenantId);
      let reservedConcurrent = false;
      try {
        const concurrent = await this.redis.incr(concKey);
        reservedConcurrent = true;
        // Refresh the safety TTL on every increment so the key never
        // outlives the configured ceiling even under steady traffic.
        await this.redis.expire(concKey, CONCURRENT_SAFETY_TTL_SEC);

        if (concurrent > limits.maxConcurrentExecutions) {
          // Roll back our reservation — quota was NOT consumed.
          await this.redis.decr(concKey);
          reservedConcurrent = false;
          return {
            allowed: false,
            reason: "CONCURRENT_EXECUTIONS_EXCEEDED",
            limit: limits.maxConcurrentExecutions,
            current: concurrent
          };
        }
      } catch {
        // Fail open on Redis errors — but if we managed to increment before
        // the error, attempt a best-effort rollback so a transient failure
        // does not permanently inflate the counter.
        if (reservedConcurrent) {
          try { await this.redis.decr(concKey); } catch { /* swallow */ }
        }
      }

      // ── Hourly counter (already atomic-then-rollback) ──────────────────
      const hourKey = this.hourlyKey(tenantId);
      try {
        const current = await this.redis.incr(hourKey);
        if (current === 1) {
          const secsUntilHourEnd = 3600 - (Math.floor(Date.now() / 1000) % 3600) + 60;
          await this.redis.expire(hourKey, secsUntilHourEnd);
        }
        if (current > limits.maxExecutionsPerHour) {
          // Roll back the hourly counter AND the concurrent reservation we
          // just took — the caller never gets to start, so neither counter
          // should be permanently charged.
          await this.redis.decr(hourKey);
          if (reservedConcurrent) {
            try { await this.redis.decr(concKey); } catch { /* swallow */ }
          }
          return {
            allowed: false,
            reason: "EXECUTIONS_PER_HOUR_EXCEEDED",
            limit: limits.maxExecutionsPerHour,
            current
          };
        }
      } catch {
        // Fail open — same rationale as above.
      }
    }

    return { allowed: true };
  }

  /**
   * Legacy: increment the concurrent execution counter.
   *
   * C-3: checkExecutionStart() now performs the atomic reservation directly
   * so callers that race two requests through both checks cannot exceed the
   * concurrent ceiling. This method is retained as a no-op-on-the-counter
   * back-compat shim: callers that already migrated to the atomic path
   * should NOT call it (it would double-charge the counter); callers that
   * still call it sequentially against the old API will see the same
   * end-state as before because checkExecutionStart() now consumes the slot
   * itself. We keep the method exported so the public API surface is
   * preserved per the change constraints.
   */
  async trackExecutionStart(_tenantId: string): Promise<void> {
    // Intentionally a no-op. checkExecutionStart() already reserved the
    // concurrent slot atomically. Calling INCR again here would race the
    // limit upward by one per invocation.
    return;
  }

  /**
   * Decrement the concurrent execution counter.
   * Must be called when an execution finishes (success, failure, or cancel).
   */
  async trackExecutionEnd(tenantId: string): Promise<void> {
    if (!this.enabled || !this.redis) return;
    const key = this.concurrentKey(tenantId);
    try {
      const val = await this.redis.decr(key);
      if (val < 0) await this.redis.set(key, "0"); // Floor at 0
    } catch { /* non-fatal */ }
  }

  /**
   * Check whether a new agent can be created for this tenant.
   * Queries Postgres (not Redis) because agent count is not cached.
   */
  async checkAgentCreation(tenantId: string): Promise<QuotaResult> {
    if (!this.enabled) return { allowed: true };
    const limits = await this.getLimits(tenantId);

    try {
      const { rows } = await this.db.query<{ count: string }>(
        "select count(*)::text as count from agents where tenant_id = $1",
        [tenantId]
      );
      const current = parseInt(rows[0]?.count ?? "0", 10);
      if (current >= limits.maxAgents) {
        return {
          allowed: false,
          reason: "MAX_AGENTS_EXCEEDED",
          limit: limits.maxAgents,
          current
        };
      }
    } catch {
      // Postgres unavailable — fail open to avoid blocking agent creation
    }
    return { allowed: true };
  }

  private async getLimits(tenantId: string): Promise<QuotaLimits> {
    const cacheKey = `quota:limits:${tenantId}`;

    if (this.redis) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) return JSON.parse(cached) as QuotaLimits;
      } catch { /* fall through */ }
    }

    try {
      const { rows } = await this.db.query<{
        max_executions_per_hour: number;
        max_events_per_day: number;
        max_concurrent_executions: number;
        max_agents: number;
      }>(
        `select max_executions_per_hour, max_events_per_day, max_concurrent_executions, max_agents
         from tenant_quotas where tenant_id = $1`,
        [tenantId]
      );

      const limits: QuotaLimits = rows.length
        ? {
            maxExecutionsPerHour: rows[0]!.max_executions_per_hour,
            maxEventsPerDay: rows[0]!.max_events_per_day,
            maxConcurrentExecutions: rows[0]!.max_concurrent_executions,
            maxAgents: rows[0]!.max_agents
          }
        : DEFAULT_LIMITS;

      if (this.redis) {
        try {
          await this.redis.setex(cacheKey, LIMITS_CACHE_TTL_SEC, JSON.stringify(limits));
        } catch { /* non-fatal */ }
      }
      return limits;
    } catch {
      return DEFAULT_LIMITS;
    }
  }

  private hourlyKey(tenantId: string): string {
    // Key per UTC hour: quota:exec:hour:{tenantId}:{YYYY-MM-DDTHH}
    const hour = new Date().toISOString().slice(0, 13); // "2026-05-24T14"
    return `quota:exec:hour:${tenantId}:${hour}`;
  }

  private concurrentKey(tenantId: string): string {
    return `quota:exec:concurrent:${tenantId}`;
  }
}
