/**
 * DedupingToolExecutor — wraps any ToolExecutor with durable per-call dedup.
 * Audit CRITICAL-1: tool side effects double-fire under queue redelivery or
 * lease reclaim. The fencing model protects events, not tool side effects;
 * this wrapper closes that hole at the executor boundary.
 *
 * Contract:
 *   • When `idempotencyKey` is present on the input, consult the dedup
 *     store BEFORE invoking the underlying tool.
 *   • When the store reports FIRST_CALL, run the underlying tool, then
 *     mark COMPLETED (or FAILED) with the output / error.
 *   • When the store reports RETURN_CACHED, short-circuit and return the
 *     cached output. The underlying tool is NOT invoked.
 *   • When the store reports POLL_FOR_RESULT, poll the store at
 *     `pollIntervalMs` until the sibling caller reaches a terminal status,
 *     then return their output (or rethrow their error). Polling is
 *     bounded by `pollTimeoutMs` so a wedged sibling can't strand us
 *     indefinitely — on timeout we treat the slot as stale and execute
 *     the tool ourselves (last-resort fallback).
 *
 * When `idempotencyKey` is absent, the wrapper transparently forwards to
 * the underlying executor — preserves back-compat with callers that have
 * not yet been updated to mint a key.
 *
 * Failure isolation:
 *   • Errors thrown by the dedup store itself (transient Postgres blip)
 *     are logged and the wrapper falls through to invoking the tool
 *     directly. Better to risk a duplicate call than to wedge every tool
 *     because the dedup table is briefly unreachable. Operators who want
 *     fail-closed behaviour can set `failClosedOnStoreError: true`.
 */

import type { ToolExecutor } from "../domain/ports.js";
import type { ToolCallDedupStore } from "../domain/toolDedup.js";
import {
  InvariantViolation,
  assertRuntimeInvariant,
  AmbiguityDetectedError
} from "./canonicalSemantics.js";
import type { FenceProtocol, FenceOwner } from "./fence/fenceProtocol.js";
import { IdempotencyPolicyEnforcer } from "./policyEnforcer.js";

/**
 * Surfaced when the canonical fence protocol detects an args-hash
 * mismatch on retry (docs/specs/fence-protocol.md invariant I5). The
 * engine catches this and either re-prompts the user to fork an
 * explicit replay branch or aborts the execution — it MUST NOT swallow
 * this error and re-invoke the tool, because that would silently fire
 * a different side effect than the recorded one.
 */
export class ReplayDivergenceError extends InvariantViolation {
  readonly name = "ReplayDivergenceError";
  constructor(
    readonly idempotencyKey: string,
    readonly recordedArgsHash: string,
    readonly observedArgsHash: string
  ) {
    super(
      `replay divergence: args drift detected for key ${idempotencyKey} ` +
        `(recorded=${recordedArgsHash} observed=${observedArgsHash})`,
      "S3"
    );
  }
}

/**
 * Surfaced when a fence-aware mark detected the worker no longer holds
 * the lease (docs/specs/fence-protocol.md invariant I4 / case C). The
 * engine treats this as a clean surrender — the new owner will retry
 * with the same idempotency key and the remote service will dedupe.
 */
export class FenceLostError extends InvariantViolation {
  readonly name = "FenceLostError";
  constructor(readonly idempotencyKey: string) {
    super(`fence lost during tool call: ${idempotencyKey}`, "L2");
  }
}

export interface DedupingToolExecutorOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Tenant the call belongs to. Required for tenant-scoped dedup rows. */
  resolveTenantId?: (input: { agentId: string; executionId: string }) => string;
  /**
   * If true, dedup-store errors throw out of execute() instead of falling
   * through to the underlying tool. Defaults to false (best-effort dedup).
   */
  failClosedOnStoreError?: boolean;
  /**
   * Optional logger. The wrapper logs poll fallthrough and store errors
   * at warn severity. If absent, console.warn is used.
   */
  logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
  /**
   * Canonical fence protocol (docs/specs/fence-state-machine.md). When
   * supplied AND a call carries the full fence coordinates (idempotencyKey,
   * numeric attempt, stepSeq, argsHash), the executor routes through the
   * explicit fence state machine instead of the legacy dedup path: the side
   * effect is guarded by a durable PENDING→EXECUTING→COMMITTED transition with
   * mandatory ownership validation. Absent ⇒ legacy dedup behaviour unchanged.
   */
  fence?: FenceProtocol;
  /** Worker id used as the fence ownership claimant when a call omits one. */
  defaultWorkerId?: string;
}

type ToolInput = Parameters<ToolExecutor["execute"]>[0];

export class DedupingToolExecutor implements ToolExecutor {
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly failClosedOnStoreError: boolean;
  private readonly resolveTenantId: ((input: { agentId: string; executionId: string }) => string) | undefined;
  private readonly fence: FenceProtocol | undefined;
  private readonly defaultWorkerId: string;
  private readonly log: (msg: string, ctx?: Record<string, unknown>) => void;

  constructor(
    private readonly inner: ToolExecutor,
    private readonly dedup: ToolCallDedupStore,
    opts: DedupingToolExecutorOptions = {}
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 250;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 60_000;
    this.failClosedOnStoreError = opts.failClosedOnStoreError ?? false;
    this.resolveTenantId = opts.resolveTenantId;
    this.fence = opts.fence;
    this.defaultWorkerId = opts.defaultWorkerId ?? "unknown";
    const logger = opts.logger;
    this.log = logger?.warn?.bind(logger)
      ?? ((msg: string, ctx?: Record<string, unknown>) => {
        // eslint-disable-next-line no-console
        console.warn(`[tool-dedup] ${msg}`, ctx);
      });
  }

  async execute(input: ToolInput): Promise<Record<string, unknown>> {
    const idempotencyKey = (input as { idempotencyKey?: string }).idempotencyKey;
    const rawAttempt = (input as { attempt?: number }).attempt;
    const attempt = rawAttempt ?? 1;
    const stepSeq = (input as { stepSeq?: number }).stepSeq;
    const argsHash = (input as { argsHash?: string }).argsHash;

    const hasFence = !!(
      this.fence &&
      idempotencyKey &&
      typeof rawAttempt === "number" &&
      stepSeq !== undefined &&
      argsHash
    );

    // Enforce capability validation middleware before proceeding to any execution
    IdempotencyPolicyEnforcer.validateExecutionSafety(input.toolName, {
      hasFence,
      operatorApproved: (input as any).operatorApproved === true
    });

    // ─── Canonical fence path (docs/specs/fence-state-machine.md) ───
    // Engage the explicit fence state machine only when a FenceProtocol is
    // wired AND the call carries the full fence coordinates. Every external
    // side effect on this path is guarded by a durable, ownership-validated
    // PENDING→EXECUTING→COMMITTED transition. Calls missing any coordinate
    // fall through to the legacy dedup path unchanged.
    if (
      this.fence &&
      idempotencyKey &&
      typeof rawAttempt === "number" &&
      stepSeq !== undefined &&
      argsHash
    ) {
      return this.executeFenced(input, {
        fence: this.fence,
        idempotencyKey,
        stepSeq,
        argsHash,
        owner: {
          workerId: (input as { workerId?: string }).workerId ?? this.defaultWorkerId,
          attempt: rawAttempt
        }
      });
    }

    if (!idempotencyKey) {
      // Legacy / non-dedupable caller — pass through unchanged.
      return this.inner.execute(input);
    }

    const tenantId = this.resolveTenantId?.({
      agentId: input.agentId,
      executionId: input.executionId
    }) ?? "system";

    assertRuntimeInvariant(
      "P2",
      typeof tenantId === "string" && tenantId.length > 0,
      "Tenant ID must be non-empty string for tool execution isolation",
      { executionId: input.executionId, idempotencyKey }
    );

    let begin;
    try {
      begin = await this.dedup.beginCall({
        idempotencyKey,
        executionId: input.executionId,
        agentId: input.agentId,
        toolName: input.toolName,
        attempt,
        tenantId,
        ...(stepSeq !== undefined ? { stepSeq } : {}),
        ...(argsHash ? { argsHash } : {}),
        // The token-at-reserve is the same as `attempt` in the V1 single-
        // attempt-per-call model. Recording it gives us a forensic anchor
        // even when the live attempt changes between reserve and commit.
        ...(attempt !== undefined ? { fenceTokenAtReserve: attempt } : {})
      });
    } catch (err) {
      if (this.failClosedOnStoreError) throw err;
      this.log("dedup.beginCall failed — falling through to direct execution", {
        idempotencyKey,
        toolName: input.toolName,
        error: err instanceof Error ? err.message : String(err)
      });
      return this.inner.execute(input);
    }

    if (begin.mode === "RETURN_CACHED") {
      return begin.output;
    }

    // docs/specs/fence-protocol.md invariant I5 — args drift on retry MUST
    // surface as an explicit divergence, never as a silent re-invocation
    // with new args.
    if (begin.mode === "ARG_DRIFT") {
      throw new ReplayDivergenceError(
        idempotencyKey,
        begin.recordedArgsHash,
        begin.observedArgsHash
      );
    }

    if (begin.mode === "POLL_FOR_RESULT") {
      const polled = await this.pollForResult(idempotencyKey);
      if (polled) return polled;
      // Sibling wedged. With the canonical fence protocol the sibling and
      // we share the SAME idempotency key, so a direct re-invocation
      // routes the duplicate request to the remote's idem-key cache and
      // is safe (remote dedupes). We log this rather than fence ourselves
      // because the stale-IN_FLIGHT reaper in the store will eventually
      // clear the slot.
      this.log("dedup.poll timed out — invoking tool directly; remote dedupe protects side effects", {
        idempotencyKey,
        toolName: input.toolName
      });
      return this.inner.execute(input);
    }

    // FIRST_CALL — we own this slot. Execute, then record.
    try {
      const output = await this.inner.execute(input);
      const fenceAware = this.canMarkFenced(input, attempt);
      try {
        if (fenceAware) {
          const outcome = await this.dedup.markCompletedFenced!({
            idempotencyKey,
            executionId: input.executionId,
            expectedFencingToken: attempt,
            output
          });
          if (outcome.outcome === "FENCED") {
            // The lease was reclaimed during the call. The new owner is
            // retrying with the same idempotency key; the remote will
            // return its cached response. Drop our local result — the
            // remote is the source of truth for whether the side effect
            // happened. (docs/specs/fence-protocol.md case C.)
            this.log("fence lost during tool call — surrendering to new owner", {
              idempotencyKey,
              toolName: input.toolName
            });
            throw new FenceLostError(idempotencyKey);
          }
        } else {
          await this.dedup.markCompleted(idempotencyKey, output);
        }
      } catch (err) {
        if (err instanceof FenceLostError) throw err;
        // Recording failure here is non-fatal — the tool already ran and
        // produced output. A sibling re-call will re-execute with the
        // same idem_key; the remote dedupes. Acceptable degradation.
        this.log("dedup.markCompleted failed — output returned but not cached", {
          idempotencyKey,
          toolName: input.toolName,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      return output;
    } catch (toolErr) {
      if (toolErr instanceof FenceLostError) throw toolErr;
      const message = toolErr instanceof Error ? toolErr.message : String(toolErr);
      const fenceAware = this.canMarkFenced(input, attempt);
      try {
        if (fenceAware) {
          await this.dedup.markFailedFenced!({
            idempotencyKey,
            executionId: input.executionId,
            expectedFencingToken: attempt,
            errorMessage: message
          });
        } else {
          await this.dedup.markFailed(idempotencyKey, message);
        }
      } catch (markErr) {
        this.log("dedup.markFailed failed — sibling polls will time out", {
          idempotencyKey,
          toolName: input.toolName,
          markError: markErr instanceof Error ? markErr.message : String(markErr)
        });
      }
      throw toolErr;
    }
  }

  /**
   * Canonical fence-state-machine execution path. Drives the side effect
   * through the explicit lifecycle so that:
   *   • F1 — the side effect fires only after a durable PENDING→EXECUTING.
   *   • F2 — every transition validates ownership (claimant attempt).
   *   • F3 — a committed/reconciled fence short-circuits, never re-fires.
   *   • F4 — a stale claimant's transitions are rejected, surrender cleanly.
   *   • F6 — replay/retry resolve through the fence; arg drift surfaces.
   */
  private async executeFenced(
    input: ToolInput,
    ctx: {
      fence: FenceProtocol;
      idempotencyKey: string;
      stepSeq: number;
      argsHash: string;
      owner: FenceOwner;
    }
  ): Promise<Record<string, unknown>> {
    const { fence, idempotencyKey, stepSeq, argsHash, owner } = ctx;
    const tenantId = this.resolveTenantId?.({
      agentId: input.agentId,
      executionId: input.executionId
    }) ?? "system";

    const resolved = await fence.reserveOrResolve({
      fenceId: idempotencyKey,
      executionId: input.executionId,
      stepSeq,
      tenantId,
      toolName: input.toolName,
      idempotencyKey,
      argsHash,
      owner
    });

    switch (resolved.kind) {
      case "RESOLVED_COMMITTED":
        // F3/F6 — a prior call already committed this exact step. Return the
        // recorded output; the external side effect is NOT re-dispatched.
        return resolved.output;
      case "ARG_DRIFT":
        // F6 — replay/retry carried drifted args. Refuse silent re-execution.
        throw new ReplayDivergenceError(
          idempotencyKey,
          resolved.recordedArgsHash,
          resolved.observedArgsHash
        );
      case "AMBIGUOUS":
        // S3 — a prior in-flight call lost its fence; the outcome is unknown.
        // Surface for reconciliation; do NOT execute.
        throw new AmbiguityDetectedError({
          executionId: input.executionId,
          toolName: input.toolName,
          args: input.args,
          idempotencyKey,
          stepSequence: stepSeq
        });
      case "RECONCILING":
        this.log("fence under reconciliation by another owner — surrendering", {
          idempotencyKey,
          toolName: input.toolName
        });
        throw new FenceLostError(idempotencyKey);
      case "IN_FLIGHT":
        // A same-attempt sibling holds the in-flight call. The remote
        // idempotency key dedupes; we surrender and let the holder commit.
        this.log("fence in-flight under sibling at same attempt — surrendering", {
          idempotencyKey,
          toolName: input.toolName
        });
        throw new FenceLostError(idempotencyKey);
      case "STALE":
        // F4 — we are a zombie (older attempt than the fence owner).
        this.log("fence owned by newer attempt — surrendering", {
          idempotencyKey,
          toolName: input.toolName
        });
        throw new FenceLostError(idempotencyKey);
      case "RESERVED":
        break;
    }

    // F1 — transition the durable fence PENDING→EXECUTING BEFORE any dispatch.
    // beginSideEffect throws StaleFenceOwnerError if we no longer own it.
    const begun = await fence.beginSideEffect({ fenceId: idempotencyKey, claimant: owner });
    assertRuntimeInvariant(
      "F1",
      begun.fence.state === "EXECUTING",
      "fence must be EXECUTING before a side effect is dispatched",
      { idempotencyKey, state: begun.fence.state }
    );

    let output: Record<string, unknown>;
    try {
      output = await this.inner.execute(input);
    } catch (toolErr) {
      const message = toolErr instanceof Error ? toolErr.message : String(toolErr);
      const failed = await fence.fail({ fenceId: idempotencyKey, claimant: owner, error: message });
      if (failed.outcome === "FENCED") {
        // We lost the lease mid-call; a new owner is reconciling. Surrender.
        this.log("fence lost during failing tool call — surrendering", {
          idempotencyKey,
          toolName: input.toolName
        });
        throw new FenceLostError(idempotencyKey);
      }
      throw toolErr;
    }

    // F2/F4 — commit requires EXACT ownership. If the lease flipped during the
    // call the commit is FENCED: the new owner moved us to AMBIGUOUS and will
    // reconcile with the same idempotency key (remote dedupes). Surrender.
    const committed = await fence.commit({ fenceId: idempotencyKey, claimant: owner, output });
    if (committed.outcome === "FENCED") {
      this.log("fence lost during tool call — surrendering to reconciler", {
        idempotencyKey,
        toolName: input.toolName
      });
      throw new FenceLostError(idempotencyKey);
    }
    return output;
  }

  /**
   * The fence-aware mark path requires (a) a numeric `attempt` token to
   * compare against `execution_leases.attempt`, and (b) a store
   * implementation that exposes `markCompletedFenced` / `markFailedFenced`.
   * Returns true only when both hold; otherwise the executor falls back
   * to the legacy non-fenced mark methods. This is the migration seam
   * documented in docs/specs/fence-protocol.md §8.
   */
  private canMarkFenced(input: ToolInput, attempt: number): boolean {
    if (typeof attempt !== "number") return false;
    if (!input.executionId) return false;
    return typeof this.dedup.markCompletedFenced === "function"
        && typeof this.dedup.markFailedFenced === "function";
  }

  private async pollForResult(
    idempotencyKey: string
  ): Promise<Record<string, unknown> | undefined> {
    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const rec = await this.dedup.get(idempotencyKey);
        if ((rec?.status === "COMPLETED" || rec?.status === "SUCCEEDED") && rec.output) {
          return rec.output;
        }
        if (rec?.status === "FAILED") {
          throw new Error(
            `Sibling tool call failed: ${rec.lastError ?? "(no message)"}`
          );
        }
      } catch (err) {
        // Transient store error — keep polling until the deadline.
        this.log("dedup.poll get failed — retrying", {
          idempotencyKey,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
    return undefined;
  }
}

/**
 * No-op ToolCallDedupStore — every beginCall returns FIRST_CALL and the
 * mark* methods are no-ops. Used in tests and in-memory dev mode where
 * the Postgres table is not provisioned. Tool side effects are NOT
 * deduped under this store — that is the in-memory mode's accepted
 * trade-off.
 */
export class NoopToolCallDedupStore implements ToolCallDedupStore {
  async beginCall() {
    return { mode: "FIRST_CALL" as const };
  }
  async markCompleted() {}
  async markFailed() {}
  async get() {
    return undefined;
  }
}
