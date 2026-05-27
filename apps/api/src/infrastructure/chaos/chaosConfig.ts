/**
 * chaosConfig — Opt-in gating for the chaos-injection layer.
 *
 * Why this is read directly from process.env (not the zod schema):
 *   The chaos layer is a verification harness, not a runtime feature. Wiring
 *   it through the zod AppConfig would force every test fixture and structural
 *   literal to know about it. Reading directly keeps the existing AppConfig
 *   contract unchanged and makes the chaos surface trivially removable by
 *   unsetting one env var.
 *
 * Strict-prod safety:
 *   `isChaosEnabled()` returns false unconditionally when NODE_ENV is
 *   production or staging. The function is exported so callers can assert
 *   that chaos is genuinely off before doing anything destructive. Defense
 *   in depth — the proxies also re-check at every call site.
 */

/** Resolved at module load and cached. */
const RAW_ENABLED = process.env.CHAOS_ENABLED;
const RAW_ENV = process.env.NODE_ENV ?? "development";

/** Single source of truth for "is the chaos layer active in this process?". */
export function isChaosEnabled(): boolean {
  if (RAW_ENV === "production" || RAW_ENV === "staging") return false;
  return RAW_ENABLED === "true" || RAW_ENABLED === "1";
}

/**
 * Throw if chaos is somehow enabled in a strict environment. Called from
 * proxy constructors as defense in depth — even if a misconfiguration were
 * to slip past `isChaosEnabled()`, this halts boot rather than silently
 * injecting faults into a production process.
 */
export function assertChaosSafeEnvironment(): void {
  if (RAW_ENV === "production" || RAW_ENV === "staging") {
    throw new Error(
      `[chaos] refused to initialise: NODE_ENV=${RAW_ENV} is strict — chaos injection is forbidden.`
    );
  }
}

/**
 * Snapshot the chaos environment for the certification report. Avoids
 * leaking process.env into the report consumer; only the fields that are
 * meaningful to the cert are exposed.
 */
export function chaosEnvironmentSnapshot(): {
  enabled: boolean;
  nodeEnv: string;
  envFile: string | null;
} {
  return {
    enabled: isChaosEnabled(),
    nodeEnv: RAW_ENV,
    envFile: process.env.APP_ENV_FILE ?? null
  };
}
