import type { AppConfig } from "../shared/config.js";
import {
  InvariantViolation,
  assertRuntimeInvariant,
  INVARIANT_REGISTRY
} from "./canonicalSemantics.js";

export { InvariantViolation, assertRuntimeInvariant, INVARIANT_REGISTRY };
export type { InvariantId } from "./canonicalSemantics.js";

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

  "production-strict-tenant-guard": (ctx) => {
    if (ctx.config.NODE_ENV !== "production") return;
    if (!ctx.tenantGuardStrict) {
      throw new InvariantViolation(
        "Tenant guard must be the strict postgres variant in production",
        "production-strict-tenant-guard"
      );
    }
  },

  "queue-visibility-vs-lease": (ctx) => {
    if (ctx.config.JOB_QUEUE_VISIBILITY_MS < ctx.config.EXECUTION_LEASE_TTL_MS) {
      throw new InvariantViolation(
        `JOB_QUEUE_VISIBILITY_MS (${ctx.config.JOB_QUEUE_VISIBILITY_MS}) must be ` +
          `>= EXECUTION_LEASE_TTL_MS (${ctx.config.EXECUTION_LEASE_TTL_MS})`,
        "queue-visibility-vs-lease"
      );
    }
  },

  "distributed-role-split": (ctx) => {
    if (ctx.config.RUNTIME_MODE !== "distributed") return;
    if (ctx.config.RUNTIME_ROLE === "combined") {
      throw new InvariantViolation(
        "RUNTIME_MODE=distributed forbids RUNTIME_ROLE=combined",
        "distributed-role-split"
      );
    }
  },

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

export function listInvariants(): string[] {
  return Object.keys(checks);
}
