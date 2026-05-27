/**
 * V3 — Automated DLQ remediation service.
 *
 * What this fixes:
 *   Before V3 the DLQ was a passive store. An operator had to manually run
 *   a replay against each entry — slow during an incident and prone to
 *   skipping entries that had transient root causes.
 *
 * What this adds:
 *   - Scheduled replay attempts with exponential backoff per entry.
 *   - Hard ceiling on replay attempts; entries past the ceiling are
 *     quarantined (moved to a separate state, never auto-replayed again).
 *   - Poison-job classification: entries whose error matches an operator
 *     blocklist (e.g. ValidationError, TenantQuotaExceeded) are quarantined
 *     immediately because retry will never help.
 *   - Replay observability: every attempt increments
 *     `agent_dlq_replay_total{outcome=...}` and the duration histogram.
 *
 * Backward compatibility:
 *   - The DeadLetterQueue port is unchanged.
 *   - Postgres DLQ already supports `resolve(executionId, resolution)` —
 *     successful replays call it with "auto-replay-succeeded".
 *   - Quarantine uses the SAME resolve() call with "quarantined:<reason>"
 *     so no schema migration is required.
 *
 * Backpressure:
 *   The remediator processes at most `concurrency` entries per tick. The
 *   tick interval is set by the caller; we default to 60s to keep the
 *   write amplification on the executions table modest.
 */

import type pino from "pino";
import type { DeadLetterQueue } from "../../domain/clusterPorts.js";
import type { DeadLetterEntry } from "../../domain/cluster.js";
import type { AgentMetrics } from "../../infrastructure/metrics/prometheusMetrics.js";
import { PostgresDeadLetterStore } from "../../infrastructure/reliability/postgresDeadLetterStore.js";
import { acquireFencingToken, assertCanWrite } from "../../infrastructure/reliability/splitBrainGuard.js";

export type ReplayOutcome = "succeeded" | "failed" | "quarantined" | "skipped";

export interface ReplayHandler {
  /**
   * Attempt to replay the execution. Returns true if the replay succeeded
   * (and the DLQ entry should be resolved), false if it failed transiently
   * (will be retried later up to the ceiling).
   *
   * MUST NOT swallow exceptions silently — throw to signal an unexpected
   * error that should be surfaced and accounted as a failed attempt.
   */
  replay(entry: DeadLetterEntry): Promise<boolean>;
}

export interface DlqRemediationOptions {
  /** How many entries to attempt per tick. */
  concurrency?: number;
  /** Maximum replay attempts before quarantine. */
  maxReplayAttempts?: number;
  /** Base backoff between replay attempts of the same entry (ms). */
  baseBackoffMs?: number;
  /** Backoff ceiling (ms). */
  maxBackoffMs?: number;
  /**
   * Substrings that, when present in entry.lastError, cause an immediate
   * quarantine without any replay attempt. These are the error categories
   * known never to recover (validation, quota, schema).
   */
  permanentFailureMarkers?: string[];
  /** Polling interval for the remediation tick (ms). */
  tickIntervalMs?: number;
}

const DEFAULTS: Required<Omit<DlqRemediationOptions, "permanentFailureMarkers">> & {
  permanentFailureMarkers: string[];
} = {
  concurrency: 4,
  maxReplayAttempts: 5,
  baseBackoffMs: 30_000,
  maxBackoffMs: 30 * 60_000,
  permanentFailureMarkers: [
    "ValidationError",
    "TenantQuotaExceeded",
    "NotFoundError",
    "PERMISSION_DENIED",
    "schema-violation"
  ],
  tickIntervalMs: 60_000
};

interface AttemptState {
  attempts: number;
  nextEligibleAt: number;
  lastError?: string;
}

export class DlqRemediationService {
  private readonly opts: typeof DEFAULTS;
  private readonly attemptState = new Map<string, AttemptState>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly dlq: DeadLetterQueue,
    private readonly handler: ReplayHandler,
    private readonly metrics: AgentMetrics | undefined,
    private readonly logger: pino.Logger,
    opts?: DlqRemediationOptions
  ) {
    this.opts = {
      concurrency: opts?.concurrency ?? DEFAULTS.concurrency,
      maxReplayAttempts: opts?.maxReplayAttempts ?? DEFAULTS.maxReplayAttempts,
      baseBackoffMs: opts?.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      maxBackoffMs: opts?.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      permanentFailureMarkers:
        opts?.permanentFailureMarkers ?? DEFAULTS.permanentFailureMarkers,
      tickIntervalMs: opts?.tickIntervalMs ?? DEFAULTS.tickIntervalMs
    };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.running) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Process one tick. Exposed so operators can trigger an immediate sweep
   * via the /operator/dlq/replay endpoint without waiting for the timer.
   */
  async tick(nowMs: number = Date.now()): Promise<{ processed: number; outcomes: ReplayOutcome[] }> {
    if (this.running) return { processed: 0, outcomes: [] };
    this.running = true;
    const outcomes: ReplayOutcome[] = [];
    try {
      const entries = await this.dlq.list();
      const eligible = entries
        .filter((e) => {
          const s = this.attemptState.get(e.executionId);
          return !s || s.nextEligibleAt <= nowMs;
        })
        .slice(0, this.opts.concurrency);
      let quarantinedTotal = 0;
      for (const entry of eligible) {
        const outcome = await this.processOne(entry, nowMs);
        outcomes.push(outcome);
        if (outcome === "quarantined") quarantinedTotal += 1;
      }
      if (this.metrics) {
        // Approximate quarantined gauge — the durable store does not yet
        // expose a count, so we surface the per-tick delta. A future patch
        // can replace this with a SELECT count(*) WHERE resolution LIKE
        // 'quarantined:%'.
        this.metrics.dlqQuarantined.inc(quarantinedTotal);
      }
      return { processed: outcomes.length, outcomes };
    } finally {
      this.running = false;
    }
  }

  private async processOne(entry: DeadLetterEntry, nowMs: number): Promise<ReplayOutcome> {
    // V3 split-brain guard — only the active region replays. Passive
    // regions must not double-execute the same DLQ entry. We acquire a
    // fencing token; assertCanWrite below ensures the topology has not
    // shifted between the start of replay and the resolve().
    let held: ReturnType<typeof acquireFencingToken>;
    try {
      held = acquireFencingToken();
    } catch (err) {
      this.logger.debug({ err, executionId: entry.executionId }, "[dlq-remediator] skipped: non-primary region");
      return "skipped";
    }

    if (this.isPermanentFailure(entry.lastError)) {
      assertCanWrite(held);
      await this.quarantine(entry, `permanent:${classify(entry.lastError)}`);
      this.metrics?.dlqReplayTotal.inc({ outcome: "quarantined" });
      return "quarantined";
    }

    const state = this.attemptState.get(entry.executionId) ?? {
      attempts: 0,
      nextEligibleAt: 0
    };

    if (state.attempts >= this.opts.maxReplayAttempts) {
      assertCanWrite(held);
      await this.quarantine(entry, `attempts-exceeded:${state.attempts}`);
      this.metrics?.dlqReplayTotal.inc({ outcome: "quarantined" });
      this.attemptState.delete(entry.executionId);
      return "quarantined";
    }

    const startedAt = Date.now();
    let ok = false;
    let thrown: unknown;
    try {
      ok = await this.handler.replay(entry);
    } catch (err) {
      thrown = err;
      ok = false;
    }
    const durationSec = (Date.now() - startedAt) / 1000;

    if (ok) {
      try {
        assertCanWrite(held);
      } catch (err) {
        // Split-brain detected mid-replay. Do not resolve the entry — the
        // new primary will pick it up.
        this.metrics?.splitBrainRejections.inc({ region: held.regionId });
        this.logger.warn({ err, executionId: entry.executionId }, "[dlq-remediator] split-brain rejected resolve");
        return "skipped";
      }
      await this.resolveOrLog(entry.executionId, "auto-replay-succeeded");
      this.metrics?.dlqReplayTotal.inc({ outcome: "succeeded" });
      this.metrics?.dlqReplayDuration.observe({ outcome: "succeeded" }, durationSec);
      this.attemptState.delete(entry.executionId);
      this.logger.info(
        { executionId: entry.executionId, attempts: state.attempts + 1 },
        "[dlq-remediator] replay succeeded"
      );
      return "succeeded";
    }

    // Failure path — bump attempts and apply exponential backoff.
    state.attempts += 1;
    const backoff = Math.min(
      this.opts.maxBackoffMs,
      this.opts.baseBackoffMs * Math.pow(2, state.attempts - 1)
    );
    state.nextEligibleAt = nowMs + backoff;
    state.lastError = thrown instanceof Error ? thrown.message : entry.lastError;
    this.attemptState.set(entry.executionId, state);

    this.metrics?.dlqReplayTotal.inc({ outcome: "failed" });
    this.metrics?.dlqReplayDuration.observe({ outcome: "failed" }, durationSec);
    this.logger.warn(
      {
        executionId: entry.executionId,
        attempts: state.attempts,
        nextEligibleInMs: backoff,
        lastError: state.lastError
      },
      "[dlq-remediator] replay failed; will retry"
    );

    if (state.attempts >= this.opts.maxReplayAttempts) {
      await this.quarantine(entry, `attempts-exceeded:${state.attempts}`);
      this.metrics?.dlqReplayTotal.inc({ outcome: "quarantined" });
      this.attemptState.delete(entry.executionId);
      return "quarantined";
    }

    return "failed";
  }

  private async quarantine(entry: DeadLetterEntry, reason: string): Promise<void> {
    this.logger.error(
      { executionId: entry.executionId, reason, lastError: entry.lastError },
      "[dlq-remediator] quarantining entry"
    );
    await this.resolveOrLog(entry.executionId, `quarantined:${reason}`);
  }

  private async resolveOrLog(executionId: string, resolution: string): Promise<void> {
    if (this.dlq instanceof PostgresDeadLetterStore) {
      await this.dlq.resolve(executionId, resolution);
      return;
    }
    // In-memory DLQ has no resolve verb — we leave the entry in place but
    // record the resolution intent on the attempt state so a follow-up
    // operator inspection sees the auto-resolution attempt.
    this.logger.debug({ executionId, resolution }, "[dlq-remediator] in-memory DLQ; resolution recorded in logs");
  }

  private isPermanentFailure(errorMessage: string | undefined): boolean {
    if (!errorMessage) return false;
    return this.opts.permanentFailureMarkers.some((m) =>
      errorMessage.includes(m)
    );
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => this.logger.error({ err }, "[dlq-remediator] tick failed"))
        .finally(() => this.scheduleNext());
    }, this.opts.tickIntervalMs);
    // Don't keep the event loop alive just for this timer — graceful
    // shutdown stops it explicitly.
    this.timer.unref?.();
  }
}

function classify(message: string | undefined): string {
  if (!message) return "unknown";
  if (message.includes("Validation")) return "validation";
  if (message.includes("Quota")) return "quota";
  if (message.includes("NotFound")) return "not-found";
  if (message.includes("PERMISSION")) return "permission";
  if (message.includes("schema")) return "schema";
  return "permanent";
}
