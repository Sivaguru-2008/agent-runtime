import { z } from "zod";
import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─── Canonical env file resolution ─────────────────────────────────────────────
// The previous loader walked three cwd-relative paths and used the first that
// existed. That meant a process launched from `apps/api` saw a different .env
// than the same process launched from the repo root — silently. Two consequences:
//   • Dev would think AUTH_ENABLED was on locally but it was off in CI.
//   • A symlinked workspace could load a stale .env from a parent directory.
//
// The canonical resolution path is now:
//
//   1. APP_ENV_FILE (explicit operator override — wins unconditionally)
//   2. <api-package-root>/.env       (anchored on THIS module's location)
//
// Anchoring on the module's own filesystem location means the loaded .env is
// the SAME file regardless of cwd. No file is loaded if neither path resolves
// — the process then relies entirely on the ambient environment (12-factor).
const HERE = dirname(fileURLToPath(import.meta.url));
// shared/config.ts → apps/api/src/shared → apps/api
const API_PACKAGE_ROOT = resolve(HERE, "..", "..");
const CANONICAL_ENV_PATH = resolve(API_PACKAGE_ROOT, ".env");

const ENV_FILE_OVERRIDE = process.env.APP_ENV_FILE;
const resolvedEnvFile = ENV_FILE_OVERRIDE
  ? resolve(ENV_FILE_OVERRIDE)
  : existsSync(CANONICAL_ENV_PATH)
    ? CANONICAL_ENV_PATH
    : undefined;

if (resolvedEnvFile) {
  if (!existsSync(resolvedEnvFile)) {
    throw new Error(
      `[config] APP_ENV_FILE=${resolvedEnvFile} does not exist. ` +
        "Either point APP_ENV_FILE at a real file or unset it to rely on ambient env."
    );
  }
  dotenv.config({ path: resolvedEnvFile });
}

/** Exposed for diagnostics — the single .env file that was actually loaded (if any). */
export const ENV_FILE_LOADED: string | null = resolvedEnvFile ?? null;

const configSchema = z.object({
  /**
   * Runtime environment mode. Drives strict-fail vs. soft-fallback behaviour
   * across the boot sequence (validateConnectivity, persistence selection,
   * tenant guard mode, auth enforcement).
   *
   *  - development : graceful memory fallbacks, permissive guard, optional auth
   *  - test        : same as development; reserved for the test runner
   *  - staging     : strict-warn — fail-hard on PG/Redis unavailability so the
   *                  pre-prod environment exercises the same code path as prod,
   *                  but auth/quota knobs may stay relaxed for QA tooling
   *  - production  : strict — no memory fallback, no permissive guard,
   *                  AUTH_ENABLED required, DATABASE_URL required
   */
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  EVENT_BUS_DRIVER: z.enum(["memory", "redis", "redis-streams"]).default("memory"),
  EVENT_STORE_DRIVER: z.enum(["memory", "postgres"]).default("memory"),
  // Driver for cognition/replay/cluster persistence. Defaults to memory in
  // development; in production this MUST be `postgres` to satisfy the durable
  // distributed cognition contract — cognition graphs, replay sessions,
  // branches, snapshots, failure signals, workers, leases, and checkpoints
  // must survive process restart.
  PERSISTENCE_DRIVER: z.enum(["memory", "postgres"]).default("memory"),
  RECOVERY_LOOP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  OTEL_SERVICE_NAME: z.string().default("agent-runtime-api"),
  LOG_LEVEL: z.string().default("info"),
  RUNTIME_MODE: z.enum(["single", "distributed"]).default("single"),
  /**
   * Role this process plays in the cluster topology:
   *   - "api"      → HTTP only: validates, persists, enqueues, streams status
   *   - "worker"   → consumes the job queue, runs ExecutionEngine, owns leases
   *   - "combined" → both roles in one process (single-machine dev / tests)
   *
   * In production distributed deployments, run `api` and `worker` as
   * independent services. "combined" is back-compat for RUNTIME_MODE=single.
   */
  RUNTIME_ROLE: z.enum(["api", "worker", "combined"]).default("combined"),
  /**
   * Driver for the cross-process execution job queue. `redis` is required for
   * RUNTIME_MODE=distributed (the API → worker boundary is a real network
   * hop). `memory` is only acceptable when everything runs in one process.
   */
  JOB_QUEUE_DRIVER: z.enum(["memory", "redis"]).default("memory"),
  /**
   * Backpressure ceiling. When `queue.depth().ready + inFlight + delayed`
   * exceeds this number, AgentRuntime.runTask rejects with BackpressureError
   * (HTTP 503). Set to 0 to disable. 0 disables — keep ≥100 in production.
   */
  QUEUE_BACKPRESSURE_THRESHOLD: z.coerce.number().int().min(0).default(0),
  /** Job-queue visibility timeout in ms (must be ≥ EXECUTION_LEASE_TTL_MS). */
  JOB_QUEUE_VISIBILITY_MS: z.coerce.number().int().positive().default(45_000),
  /** Worker consumer group — workers in the same group share the queue. */
  JOB_QUEUE_CONSUMER_GROUP: z.string().default("agent-runtime-workers"),
  /** Exponential backoff base for retries after transient failures (ms). */
  RETRY_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(500),
  /** Exponential backoff ceiling (ms). */
  RETRY_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
  WORKER_ID: z.string().default("api-embedded-worker"),
  WORKER_CAPACITY: z.coerce.number().int().positive().default(4),
  WORKER_HEARTBEAT_TTL_MS: z.coerce.number().int().positive().default(15_000),
  WORKER_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  /** Terminal (LOST/STOPPED) workers older than this are permanently reaped. Default 24h. */
  WORKER_REAP_AFTER_MS: z.coerce.number().int().positive().default(86_400_000),
  EXECUTION_LEASE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  SCHEDULER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  // ─── Groq (used when MODEL_PROVIDER=groq or by LiveExecutionEngine) ────────
  // Groq exposes an OpenAI-compatible API. GROQ_API_KEY authenticates every
  // call; GROQ_BASE_URL / GROQ_MODEL allow pointing at a proxy or pinning a
  // model without code changes.
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  GROQ_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // Sprint Hardening 3 — bounded SSE dedupe window.
  SSE_DEDUPE_WINDOW: z.coerce.number().int().positive().default(1024),
  // Sprint Hardening 3 — fail-fast worker startup.
  WORKER_REGISTRATION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ─── Phase 2: Reliability Hardening ──────────────────────────────────────
  // Poison-pill protection: maximum number of lease.attempt increments before
  // an execution is moved to the Dead-Letter Queue and permanently stopped.
  // Each reclaim + re-acquire increments the attempt counter in Postgres, so
  // this limit is durable across process restarts.
  POISON_PILL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(3),

  // How often the LeaseHeartbeatWorker checks tracked leases for renewal (ms).
  // Defaults to 10% of EXECUTION_LEASE_TTL_MS for a comfortable safety margin.
  LEASE_HEARTBEAT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3_000),

  // Circuit breaker: how many consecutive failures before opening the circuit.
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
  // How long to keep the circuit OPEN before attempting a probe (ms).
  CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Consecutive successes in HALF_OPEN state required to close the circuit.
  CIRCUIT_BREAKER_SUCCESS_THRESHOLD: z.coerce.number().int().min(1).default(2),

  // ─── Phase 1: Real AI execution ───────────────────────────────────────────
  // Which LLM backend to use. "deterministic" is the safe default for local
  // development without API keys; set to "claude", "openai", or "groq" for
  // real inference.
  MODEL_PROVIDER: z.enum(["deterministic", "claude", "openai", "groq", "failover"]).default("deterministic"),
  // Override the default model name for the selected provider.
  // claude → claude-sonnet-4-6 | openai → gpt-4o | groq → llama-3.3-70b-versatile
  MODEL_NAME: z.string().optional(),
  // API keys for cloud providers. Required when MODEL_PROVIDER is set to the
  // corresponding provider; validated at boot time via loadConfig().
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // Per-request wall-clock timeout for provider calls (each attempt).
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // How many times to retry a transient provider error (rate-limit, 5xx,
  // network blip) before propagating the failure.
  PROVIDER_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),

  // ─── LLM response cache ───────────────────────────────────────────────────
  // Memoise deterministic (temperature=0) completions keyed by prompt hash so
  // identical re-runs / retries / duplicate traffic don't re-bill the provider.
  // Off by default — turning it on changes nothing for non-deterministic agents
  // and is a pure spend/latency win for deterministic ones. Backed by an
  // in-process TTL+LRU cache today; a Redis store is a drop-in (see
  // providers/responseCache.ts) when REDIS_URL is configured.
  // Optional (like STRICT_PROD / ALLOW_MEMORY_FALLBACK) so existing test
  // fixtures that build a structural AppConfig literal need no change; read
  // sites treat undefined as "disabled".
  LLM_RESPONSE_CACHE_ENABLED: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v): boolean | undefined => {
      if (v === false || v === "false" || v === "0") return false;
      if (v === true || v === "true" || v === "1") return true;
      return undefined;
    }),
  // Entry lifetime in ms. Default 15 minutes per the hardening spec.
  LLM_RESPONSE_CACHE_TTL_MS: z.coerce.number().int().positive().optional(),
  // Max retained entries in the in-process cache before LRU eviction.
  LLM_RESPONSE_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().optional(),

  // ─── Tool registry ────────────────────────────────────────────────────────
  // Brave Search API key — enables richer web.search results. Falls back to
  // DuckDuckGo Instant Answer API (free, no key) when absent.
  BRAVE_API_KEY: z.string().optional(),
  // Directory that file.read is restricted to. Defaults to process.cwd().
  FILE_READ_BASE_PATH: z.string().optional(),
  // Hard upper bound on bytes returned by file.read. Default 32 KiB.
  FILE_READ_MAX_BYTES: z.coerce.number().int().positive().default(32_768),
  // Timeout for web.search HTTP requests in ms.
  TOOL_WEB_SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Wall-clock timeout for code.execute sandbox in ms.
  TOOL_CODE_EXECUTE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  // V8 old-space ceiling for the code.execute child process in MB. The sandbox
  // is a separate, permission-jailed Node process; this caps its heap so an
  // OOM crashes only the child, never the API host. Optional (read sites apply
  // the 128 default) so existing AppConfig test fixtures need no change.
  TOOL_CODE_EXECUTE_MEMORY_MB: z.coerce.number().int().positive().optional(),
  // Strict tool allowlist (comma-separated). When non-empty, ONLY these tools
  // may be executed by an agent — every other tool (including any the model
  // requests via prompt injection) is denied. Empty/unset = capability-baseline
  // mode (tools classified UNSAFE are always denied; others permitted). The
  // strict allowlist is the recommended production posture. Example:
  //   TOOL_ALLOWLIST=web.search,file.read,code.execute,memory.summarize,runtime.inspect
  // Optional so existing AppConfig test fixtures need no change.
  TOOL_ALLOWLIST: z.string().optional(),

  // ─── Phase 4: Observability ───────────────────────────────────────────────
  // Enable the Prometheus /metrics endpoint. Disable in environments where the
  // endpoint should not be publicly reachable (add auth middleware separately).
  METRICS_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  // Max number of events to scan when resolving a traceId lineage query.
  // For deployments with >5k events, add a Postgres index on
  // events(metadata->>'traceId') and lower this to 1000.
  TRACE_LINEAGE_SCAN_LIMIT: z.coerce.number().int().positive().default(5_000),

  // ─── Phase 5: Security ────────────────────────────────────────────────────
  // Enable API key authentication. When false, all endpoints are publicly
  // accessible — acceptable for local dev, unacceptable in production.
  AUTH_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Comma-separated list of URL paths that bypass authentication.
  // /health is always included regardless of this setting. /ready is the V3
  // readiness probe path (k8s readinessProbe target); it is bypass-listed by
  // default because the LB must reach it without holding an API key.
  AUTH_SKIP_PATHS: z.string().default("/metrics,/ready"),

  // Role granted to the synthetic tenant when AUTH_ENABLED=false (local dev /
  // in-memory tests only — strict environments REFUSE to boot with auth off).
  // Defaults to "developer": the pre-hardening behaviour granted "admin" to
  // every unauthenticated caller, a privilege-escalation fallback that this
  // hardening removes. Operators who need the operator/admin dashboard in a
  // local unauthenticated run must opt in EXPLICITLY by setting this. Optional
  // so existing AppConfig test fixtures need no change (read site defaults to
  // "developer").
  AUTH_DISABLED_FALLBACK_ROLE: z
    .enum(["viewer", "auditor", "developer", "operator", "admin", "owner"])
    .optional(),

  // How long (seconds) a validated API key stays cached in Redis before
  // a fresh Postgres lookup is required. Longer TTL = fewer DB hits but
  // slower revocation propagation. 300s (5 min) is the recommended default.
  API_KEY_CACHE_TTL_SEC: z.coerce.number().int().positive().default(300),

  // Enable Redis sliding-window rate limiting. Requires REDIS_URL.
  RATE_LIMIT_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Requests per minute cap applied to unauthenticated IPs. Authenticated
  // tenants use the per-key rate_limit_rpm stored in api_keys.
  RATE_LIMIT_DEFAULT_RPM: z.coerce.number().int().positive().default(1_000),

  // Sliding window duration in milliseconds (default: 1 minute).
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Enable structured audit logging to the audit_log table. Requires
  // PERSISTENCE_DRIVER=postgres (audit_log is not in the in-memory adapter).
  AUDIT_LOG_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Enable per-tenant quota enforcement via Redis + Postgres tenant_quotas.
  QUOTA_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // ─── Self-serve onboarding (POST /signup) ─────────────────────────────────
  // All SIGNUP_* fields are OPTIONAL (output `… | undefined`) so the structural
  // AppConfig literals built by test fixtures need no change; read sites in
  // app.ts apply the documented defaults. A deployment with no SIGNUP_* env set
  // therefore behaves exactly as before — no public credential-minting surface.
  //
  // Master switch for the public, unauthenticated signup endpoint that mints a
  // `developer`-role API key + a fresh `starter` tenant. Default OFF.
  SIGNUP_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),

  // When true, anyone can self-serve a key (open beta). When false (default),
  // the caller MUST present an invite code from SIGNUP_INVITE_CODES. Invite-
  // gating is the right posture for the design-partner stage: removes the
  // manual seed-owner-key step without opening an abusable public faucet.
  SIGNUP_OPEN: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),

  // Comma-separated invite codes accepted when SIGNUP_OPEN=false. Each design
  // partner gets one; they self-onboard in <60s instead of you SSHing in.
  SIGNUP_INVITE_CODES: z.string().optional(),

  // Plan assigned to tenants created via self-serve signup. `starter` carries
  // the default bounded quotas from migration 0002 (100 exec/hr, 50 agents…),
  // so a free signup can never exhaust the cluster.
  SIGNUP_DEFAULT_PLAN: z.enum(["starter", "growth", "enterprise"]).optional(),

  // Per-key RPM stamped on self-serve developer keys. Generous for evaluation,
  // bounded against abuse. Overridable per-tenant later via the admin API.
  SIGNUP_DEFAULT_RPM: z.coerce.number().int().positive().optional(),

  // ─── Funnel analytics alerts (Phase 2) ────────────────────────────────────
  // All optional so existing AppConfig literals need no change; read sites in
  // app.ts apply DEFAULT_ALERT_CONFIG values. Alerts are OFF by default — a
  // deployment with no FUNNEL_ALERT* env behaves exactly as before.
  //
  // Master switch for funnel threshold alert evaluation (GET /admin/funnel/alerts).
  FUNNEL_ALERTS_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
  // Activation-rate floor (0..1). Below this, with enough sample, fires.
  FUNNEL_ALERT_MIN_ACTIVATION_RATE: z.coerce.number().min(0).max(1).optional(),
  // Trailing window (days) the activation-rate rule measures over.
  FUNNEL_ALERT_ACTIVATION_WINDOW_DAYS: z.coerce.number().int().positive().optional(),
  // Minimum signups in the window before the activation-rate rule can fire.
  FUNNEL_ALERT_MIN_SAMPLE: z.coerce.number().int().min(0).optional(),
  // Max hours since the last signup before the signup-gap rule fires.
  FUNNEL_ALERT_MAX_SIGNUP_GAP_HOURS: z.coerce.number().positive().optional(),

  // How long to wait for in-flight connections to drain before force-exiting
  // on SIGTERM. Should be less than Kubernetes terminationGracePeriodSeconds.
  SHUTDOWN_DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // D5 — Explicit strict-production switch. Optional so existing test
  // fixtures that build a structural AppConfig literal need no change;
  // read sites treat undefined as false. Independent of NODE_ENV so an
  // operator can force the strict contract on in staging-like environments
  // without flipping NODE_ENV.
  STRICT_PROD: z.coerce.boolean().optional(),

  // D2 — Failover provider chain. Optional for the same backward-compat
  // reason; the providerFactory reads it with a default of
  // "claude,openai,groq" when undefined.
  MODEL_FAILOVER_CHAIN: z.string().optional(),

  // ─── Sprint Stabilization — explicit fallback gate ────────────────────────
  // Memory-mode fallback (driver downgrade when Postgres or Redis is
  // unreachable at boot) is now opt-in via this flag. The previous behaviour
  // — "any non-strict env silently downgrades" — concealed misconfiguration:
  // a developer who FORGOT to start `docker-compose up postgres` would still
  // see a "running" API while every execution was being persisted to a heap
  // that died with the process. Strict mode (production/staging) is
  // unaffected; it still rejects the fallback unconditionally.
  //
  // Effective rules:
  //   strict (production/staging/STRICT_PROD)  → fallback always forbidden
  ENABLE_OUTBOX_DISPATCH: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v): boolean | undefined => {
      if (v === false || v === "false" || v === "0") return false;
      if (v === true || v === "true" || v === "1") return true;
      return undefined;
    }),

  //   ALLOW_MEMORY_FALLBACK=true               → fallback permitted
  //   otherwise (default in development/test)  → fallback forbidden, boot fails
  // Optional so existing test fixtures that build a structural AppConfig
  // literal need no change. Absence is treated as `false` (forbid fallback)
  // by `isMemoryFallbackPermitted`. The explicit return type below keeps
  // the inferred AppConfig field as `boolean | undefined` rather than
  // `boolean`, preserving backward compatibility with object-literal
  // construction in tests.
  ALLOW_MEMORY_FALLBACK: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v): boolean | undefined => {
      if (v === false || v === "false" || v === "0") return false;
      if (v === true || v === "true" || v === "1") return true;
      return undefined;
    }),

  // Local-development migration checksum recovery. DEV ONLY. When true, the
  // MigrationRunner re-applies and re-stamps migrations whose on-disk file has
  // drifted from the recorded checksum instead of crashing with
  // MigrationChecksumError. This bypasses the tamper guard, so it is hard-
  // refused in strict/production mode (see server.ts) — it exists only to
  // recover a developer DB whose migration files were edited after apply.
  MIGRATIONS_REPAIR_CHECKSUMS: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v): boolean | undefined => {
      if (v === false || v === "false" || v === "0") return false;
      if (v === true || v === "true" || v === "1") return true;
      return undefined;
    })
});

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Strict infrastructure mode — production and staging require real, durable
 * infrastructure to be reachable at boot. Failure to reach Postgres or Redis
 * (when the configured drivers select them) must crash the process rather
 * than silently downgrade to the in-memory fallback, which would violate the
 * durability contract the runtime advertises.
 *
 * Development and test keep the graceful fallback so a developer without a
 * local Postgres can still boot the API.
 */
export function isStrictInfrastructureMode(env: AppConfig["NODE_ENV"]): boolean {
  return env === "production" || env === "staging";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL || process.env.DATABASE_URL;

  // ─── Deterministic persistence resolution ───────────────────────────────────
  // Previously this block UNCONDITIONALLY rewrote PERSISTENCE_DRIVER and
  // EVENT_STORE_DRIVER based on whether DATABASE_URL was set. That meant an
  // operator who explicitly set PERSISTENCE_DRIVER=postgres but forgot
  // DATABASE_URL got a silently demoted boot into memory mode. Worse, a
  // strict-prod misconfiguration could be masked because the demotion ran
  // before strict-mode validation observed the user's INTENT.
  //
  // New rule: if the operator explicitly sets a driver, honor it (and let
  // the validator below reject the misconfig). Only fall back to defaulting
  // by DATABASE_URL presence when neither driver is explicitly configured.
  const persistenceExplicit = env.PERSISTENCE_DRIVER !== undefined && env.PERSISTENCE_DRIVER !== "";
  const eventStoreExplicit = env.EVENT_STORE_DRIVER !== undefined && env.EVENT_STORE_DRIVER !== "";

  if (!persistenceExplicit) {
    env.PERSISTENCE_DRIVER = databaseUrl ? "postgres" : "memory";
  }
  if (!eventStoreExplicit) {
    env.EVENT_STORE_DRIVER = databaseUrl ? "postgres" : "memory";
  }

  const parsed = configSchema.parse(env);

  if (parsed.EVENT_STORE_DRIVER === "postgres" && !parsed.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when EVENT_STORE_DRIVER=postgres");
  }

  if (parsed.PERSISTENCE_DRIVER === "postgres" && !parsed.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when PERSISTENCE_DRIVER=postgres");
  }

  if ((parsed.EVENT_BUS_DRIVER === "redis" || parsed.EVENT_BUS_DRIVER === "redis-streams") && !parsed.REDIS_URL) {
    throw new Error("REDIS_URL is required when EVENT_BUS_DRIVER is a redis driver");
  }

  if (parsed.RUNTIME_MODE === "distributed" && parsed.EVENT_BUS_DRIVER !== "redis-streams") {
    throw new Error("RUNTIME_MODE=distributed requires EVENT_BUS_DRIVER=redis-streams");
  }

  // True distributed mode REQUIRES a real cross-process queue. Otherwise the
  // API and workers are unreachable to each other, which is the simulation
  // the new topology eliminates.
  if (parsed.RUNTIME_MODE === "distributed" && parsed.JOB_QUEUE_DRIVER !== "redis") {
    throw new Error(
      "RUNTIME_MODE=distributed requires JOB_QUEUE_DRIVER=redis — " +
        "an in-memory queue cannot cross process boundaries."
    );
  }

  if (parsed.JOB_QUEUE_DRIVER === "redis" && !parsed.REDIS_URL) {
    throw new Error("REDIS_URL is required when JOB_QUEUE_DRIVER=redis");
  }

  if (parsed.JOB_QUEUE_VISIBILITY_MS < parsed.EXECUTION_LEASE_TTL_MS) {
    throw new Error(
      `JOB_QUEUE_VISIBILITY_MS (${parsed.JOB_QUEUE_VISIBILITY_MS}) must be ≥ ` +
        `EXECUTION_LEASE_TTL_MS (${parsed.EXECUTION_LEASE_TTL_MS}) so the queue ` +
        `does not re-deliver a job while a worker still holds an active lease.`
    );
  }

  if (parsed.RUNTIME_MODE === "distributed" && parsed.RUNTIME_ROLE === "combined") {
    throw new Error(
      "RUNTIME_MODE=distributed forbids RUNTIME_ROLE=combined — " +
        "set RUNTIME_ROLE=api on the API process and RUNTIME_ROLE=worker on the worker process."
    );
  }

  // Durable cognition runtime requires the Sprint Next stores to be on
  // Postgres in production AND staging. Refuse to boot with in-memory
  // persistence — replay/branch/snapshot state would vanish on restart,
  // violating the deterministic-replay guarantee. Staging is held to the
  // same bar so the pre-prod environment exercises the same persistence
  // path as production.
  if (
    (parsed.NODE_ENV === "production" || parsed.NODE_ENV === "staging") &&
    parsed.PERSISTENCE_DRIVER !== "postgres"
  ) {
    throw new Error(
      `PERSISTENCE_DRIVER must be 'postgres' when NODE_ENV=${parsed.NODE_ENV} — ` +
        "the in-memory adapter loses cognition/replay state on restart."
    );
  }

  // Phase 1: validate provider-specific API key requirements at boot time so
  // missing credentials surface immediately rather than at the first inference
  // call.
  if (parsed.MODEL_PROVIDER === "claude" && !parsed.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required when MODEL_PROVIDER=claude");
  }
  if (parsed.MODEL_PROVIDER === "openai" && !parsed.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when MODEL_PROVIDER=openai");
  }
  if (parsed.MODEL_PROVIDER === "groq" && !parsed.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is required when MODEL_PROVIDER=groq");
  }

  // Phase 5: Enforce security requirements in production.
  // Production AND any STRICT_PROD-forced environment must run authenticated.
  // This is the primary guarantee that the unauthenticated "synthetic admin/dev
  // tenant" code path in registerApiKeyAuth can NEVER be reached in production;
  // registerApiKeyAuth re-asserts the same rule as defense in depth.
  if ((parsed.NODE_ENV === "production" || parsed.STRICT_PROD === true) && !parsed.AUTH_ENABLED) {
    throw new Error(
      "AUTH_ENABLED must be 'true' in production (or when STRICT_PROD=true) — " +
        "unauthenticated endpoints are not acceptable in a production deployment."
    );
  }

  if (parsed.RATE_LIMIT_ENABLED && !parsed.REDIS_URL) {
    throw new Error("REDIS_URL is required when RATE_LIMIT_ENABLED=true");
  }

  if (parsed.AUTH_ENABLED && !parsed.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when AUTH_ENABLED=true");
  }

  // L-1: defense in depth. The app-layer bootstrap also refuses to boot
  // without DATABASE_URL in production, but rejecting earlier in loadConfig
  // gives a clearer error and prevents the runtime container from being
  // built only to be torn down moments later. AUTH_ENABLED is already
  // required in production above; DATABASE_URL is required for AUTH so
  // this catches the misconfiguration of AUTH_ENABLED=false in production
  // without a database — which would otherwise silently boot a fully
  // permissive tenant guard.
  if (parsed.NODE_ENV === "production" && !parsed.DATABASE_URL) {
    throw new Error(
      "[L-1] DATABASE_URL is required when NODE_ENV=production — " +
        "the strict TenantGuard cannot resolve resource ownership without a database."
    );
  }

  // Staging mirrors production's durability contract. Auth knobs are still
  // operator-controlled (QA may run with AUTH disabled against scratch data),
  // but the durable storage path is non-negotiable.
  if (parsed.NODE_ENV === "staging" && !parsed.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required when NODE_ENV=staging — staging mirrors " +
        "the production durability contract."
    );
  }

  if (parsed.AUDIT_LOG_ENABLED && parsed.PERSISTENCE_DRIVER !== "postgres") {
    throw new Error(
      "PERSISTENCE_DRIVER=postgres is required when AUDIT_LOG_ENABLED=true — " +
        "the in-memory adapter has no audit_log table."
    );
  }

  return parsed;
}

/**
 * Determine whether memory-mode fallback (Postgres/Redis unreachable at boot
 * → switch to in-memory drivers) is permitted. Strict environments NEVER
 * permit it. Non-strict environments must opt in via ALLOW_MEMORY_FALLBACK
 * — the previous silent downgrade hid serious misconfiguration.
 */
export function isMemoryFallbackPermitted(config: AppConfig): boolean {
  if (isStrictInfrastructureMode(config.NODE_ENV) || config.STRICT_PROD === true) {
    return false;
  }
  // Frictionless dev: permit in-memory fallback by default in local dev/test
  // unless explicitly disabled by setting ALLOW_MEMORY_FALLBACK=false.
  return config.ALLOW_MEMORY_FALLBACK !== false;
}

// In assertActivePersistence the same comparison is used implicitly via the
// `=== true` check below — keep the semantics aligned.

/**
 * Post-bootstrap assertion that the persistence layer that actually got wired
 * matches the configured driver. Catches a class of bugs where a refactor
 * accidentally substitutes an in-memory adapter into a process whose config
 * claims "postgres" — the kind of substitution that would not show up in
 * routes or tests but would lose all execution state on restart in production.
 *
 * Called from the boot sequence in server.ts/workerProcess.ts immediately
 * after createRuntimeContainer/createWorkerContainer returns.
 */
export function assertActivePersistence(
  config: AppConfig,
  actualDriver: "memory" | "postgres"
): void {
  if (actualDriver === config.PERSISTENCE_DRIVER) return;

  const isStrict = isStrictInfrastructureMode(config.NODE_ENV) || config.STRICT_PROD === true;
  const message =
    `[startup] persistence driver mismatch: config requested "${config.PERSISTENCE_DRIVER}" ` +
    `but runtime container constructed "${actualDriver}". This is a build/wiring bug — ` +
    `the runtime must not be allowed to advertise durability it does not have.`;

  if (isStrict) {
    throw new Error(message);
  }

  // In non-strict mode we only get here when ALLOW_MEMORY_FALLBACK was set
  // and a downgrade actually occurred. Tolerated but explicit.
  if (
    actualDriver === "memory" &&
    config.PERSISTENCE_DRIVER === "postgres" &&
    config.ALLOW_MEMORY_FALLBACK === true
  ) {
    return;
  }
  throw new Error(message);
}
