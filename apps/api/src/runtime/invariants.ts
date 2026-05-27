/**
 * V3 — Strict runtime invariants.
 *
 * What this is:
 *   A library of small, fast checks that assert non-trivial runtime
 *   guarantees. They are called from `assertProductionInvariants()`
 *   on the production boot path AND from a dedicated CI test
 *   (test/invariants/) so a regression that violates a contract trips
 *   the build before a release goes out.
 *
 * Why a module rather than inline asserts:
 *   - The same invariants are checked from server.ts AND
 *     workerProcess.ts, so duplicating them inline drifts.
 *   - The CI suite runs the invariants against fakes to ensure they
 *     correctly REJECT misconfiguration, not just accept the happy path.
 */

import type { AppConfig } from "../shared/config.js";

export class InvariantViolation extends Error {
  readonly code = "INVARIANT_VIOLATION" as const;
  constructor(message: string, public readonly invariant: string) {
    super(`[invariant:${invariant}] ${message}`);
  }
}

export interface InvariantContext {
  config: AppConfig;
  /** True if the OTel SDK has actually started. */
  otelStarted: boolean;
  /** True if the security DB (Postgres) is constructed. */
  securityDbBound: boolean;
  /** True if the runtime container's tenant guard is the strict postgres variant. */
  tenantGuardStrict: boolean;
}

type InvariantCheck = (ctx: InvariantContext) => void;

const checks: Record<string, InvariantCheck> = {
  /**
   * Production must have AUTH_ENABLED and DATABASE_URL — already enforced
   * by loadConfig, but re-checked here so a future refactor that breaks
   * loadConfig surfaces immediately at the boot invariants instead of
   * silently shipping.
   */
  "production-auth-and-db": (ctx) => {
    if (ctx.config.NODE_ENV !== "production") return;
    if (!ctx.config.AUTH_ENABLED) {
      throw new InvariantViolation(
        "AUTH_ENABLED must be true in production",
        "production-auth-and-db"
      );
    }
    if (!ctx.config.DATABASE_URL) {
      throw new InvariantViolation(
        "DATABASE_URL must be set in production",
        "production-auth-and-db"
      );
    }
  },

  /**
   * Production must use the strict tenant guard. A permissive guard in
   * production is a cross-tenant data leak.
   */
  "production-strict-tenant-guard": (ctx) => {
    if (ctx.config.NODE_ENV !== "production") return;
    if (!ctx.tenantGuardStrict) {
      throw new InvariantViolation(
        "Tenant guard must be the strict postgres variant in production",
        "production-strict-tenant-guard"
      );
    }
  },

  /**
   * Job-queue visibility timeout must be at least the execution lease TTL.
   * Re-deriving the check here makes a future config refactor obvious if it
   * accidentally drops the constraint.
   */
  "queue-visibility-vs-lease": (ctx) => {
    if (ctx.config.JOB_QUEUE_VISIBILITY_MS < ctx.config.EXECUTION_LEASE_TTL_MS) {
      throw new InvariantViolation(
        `JOB_QUEUE_VISIBILITY_MS (${ctx.config.JOB_QUEUE_VISIBILITY_MS}) must be ` +
          `>= EXECUTION_LEASE_TTL_MS (${ctx.config.EXECUTION_LEASE_TTL_MS})`,
        "queue-visibility-vs-lease"
      );
    }
  },

  /**
   * Distributed mode requires the worker role split — combined-mode in
   * distributed deployments would re-introduce the single-machine race.
   */
  "distributed-role-split": (ctx) => {
    if (ctx.config.RUNTIME_MODE !== "distributed") return;
    if (ctx.config.RUNTIME_ROLE === "combined") {
      throw new InvariantViolation(
        "RUNTIME_MODE=distributed forbids RUNTIME_ROLE=combined",
        "distributed-role-split"
      );
    }
  },

  /**
   * Distributed mode requires the redis-streams event bus AND redis job
   * queue — otherwise API and workers cannot reach each other.
   */
  "distributed-bus-and-queue": (ctx) => {
    if (ctx.config.RUNTIME_MODE !== "distributed") return;
    if (ctx.config.EVENT_BUS_DRIVER !== "redis-streams") {
      throw new InvariantViolation(
        "Distributed runtime requires EVENT_BUS_DRIVER=redis-streams",
        "distributed-bus-and-queue"
      );
    }
    if (ctx.config.JOB_QUEUE_DRIVER !== "redis") {
      throw new InvariantViolation(
        "Distributed runtime requires JOB_QUEUE_DRIVER=redis",
        "distributed-bus-and-queue"
      );
    }
  },

  /**
   * Staging and production must NOT use the in-memory persistence driver —
   * cognition/replay state would vanish on restart.
   */
  "non-memory-persistence": (ctx) => {
    const env = ctx.config.NODE_ENV;
    if (env !== "production" && env !== "staging") return;
    if (ctx.config.PERSISTENCE_DRIVER !== "postgres") {
      throw new InvariantViolation(
        `PERSISTENCE_DRIVER must be 'postgres' when NODE_ENV=${env}`,
        "non-memory-persistence"
      );
    }
  }
};

/**
 * Run every invariant check. Throws on the FIRST violation so the boot
 * sequence fails loudly with the most informative error.
 */
export function assertProductionInvariants(ctx: InvariantContext): void {
  for (const [name, check] of Object.entries(checks)) {
    try {
      check(ctx);
    } catch (err) {
      if (err instanceof InvariantViolation) throw err;
      throw new InvariantViolation(
        `unexpected error while checking invariant: ${(err as Error).message}`,
        name
      );
    }
  }
}

/**
 * Used by the test suite to enumerate every invariant name without invoking
 * the checks. The CI test then calls each one with a context tailored to
 * exercise both happy-path and rejection-path.
 */
export function listInvariants(): string[] {
  return Object.keys(checks);
}
