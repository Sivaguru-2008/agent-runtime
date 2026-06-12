/**
 * Regression lock for the two sales demos (apps/api/demo/*).
 *
 * These assert the exact guarantees the demos claim, against the same real
 * production code the demos exercise:
 *   1. DedupingToolExecutor collapses a redelivered side effect to one call.
 *   2. ExecutionLoopDetector trips on a runaway retry stream within 3 turns.
 *
 * If a refactor breaks a demo's promise, this fails — so the clip you show a
 * customer never quietly stops being true.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DedupingToolExecutor } from "../src/runtime/toolDedupExecutor.js";
import type {
  ToolCallDedupStore,
  ToolCallDedupBegin,
  ToolCallDedupRecord,
  BeginCallMode
} from "../src/domain/toolDedup.js";
import { sideEffectCapabilityRegistry } from "../src/runtime/canonicalSemantics.js";
import type { ToolExecutor } from "../src/domain/ports.js";
import { ExecutionLoopDetector } from "../src/runtime/failure/analyzers/executionLoopDetector.js";
import type { DomainEvent, DomainEventType } from "../src/domain/events.js";
import type { AnalyzerContext, FailureSignal } from "../src/domain/failure.js";

// ── In-memory dedup store: same contract as the production Postgres store,
//    same one the double-charge demo uses. ────────────────────────────────────
class InMemoryDedupStore implements ToolCallDedupStore {
  private rows = new Map<string, ToolCallDedupRecord>();
  async beginCall(input: ToolCallDedupBegin): Promise<BeginCallMode> {
    const existing = this.rows.get(input.idempotencyKey);
    if (!existing) {
      this.rows.set(input.idempotencyKey, {
        idempotencyKey: input.idempotencyKey,
        executionId: input.executionId,
        agentId: input.agentId,
        toolName: input.toolName,
        attempt: input.attempt,
        status: "IN_FLIGHT",
        createdAt: new Date().toISOString(),
        tenantId: input.tenantId
      });
      return { mode: "FIRST_CALL" };
    }
    if ((existing.status === "COMPLETED" || existing.status === "SUCCEEDED") && existing.output) {
      return { mode: "RETURN_CACHED", output: existing.output };
    }
    return { mode: "POLL_FOR_RESULT", sinceMs: 0 };
  }
  async markCompleted(key: string, output: Record<string, unknown>): Promise<void> {
    const row = this.rows.get(key);
    if (row) { row.status = "COMPLETED"; row.output = output; }
  }
  async markFailed(key: string, errorMessage: string): Promise<void> {
    const row = this.rows.get(key);
    if (row) { row.status = "FAILED"; row.lastError = errorMessage; }
  }
  async get(key: string): Promise<ToolCallDedupRecord | undefined> {
    return this.rows.get(key);
  }
}

class CountingTool implements ToolExecutor {
  invocations = 0;
  async execute(): Promise<Record<string, unknown>> {
    this.invocations++;
    return { chargeId: `ch_${this.invocations}`, status: "succeeded" };
  }
}

const chargeCall = {
  toolName: "payment.charge",
  args: { customerId: "cus_x", amountCents: 50_000 },
  executionId: "exec-demo-1",
  agentId: "agent-demo",
  idempotencyKey: "exec-demo-1:step3:payment.charge",
  attempt: 1
};

describe("demo guardrail 1 — duplicate charge", () => {
  beforeEach(() => {
    sideEffectCapabilityRegistry.register("payment.charge", "NON_IDEMPOTENT");
  });

  it("without the guardrail, a redelivery double-fires the side effect", async () => {
    const tool = new CountingTool();
    await tool.execute();
    await tool.execute();
    expect(tool.invocations).toBe(2); // the bug the demo dramatizes
  });

  it("with the guardrail, a redelivery fires the side effect exactly once", async () => {
    const tool = new CountingTool();
    const guarded = new DedupingToolExecutor(tool, new InMemoryDedupStore());

    const first = await guarded.execute(chargeCall);
    const second = await guarded.execute(chargeCall); // same idempotency key

    expect(tool.invocations).toBe(1);
    expect(second).toEqual(first); // redelivery returns the recorded result
  });
});

// ── Runaway-loop stream builder, mirroring the demo. ──────────────────────────
let seq = 0;
function evt(type: DomainEventType, payload: Record<string, unknown>): DomainEvent {
  seq += 1;
  return {
    id: `evt_${seq}`,
    type,
    aggregateId: "exec-loop",
    aggregateType: "EXECUTION",
    version: seq,
    timestamp: new Date(seq * 1000).toISOString(),
    payload,
    metadata: {
      traceId: "t",
      correlationId: "c",
      schemaVersion: 1,
      source: "test",
      idempotencyKey: `idem_${seq}`
    },
    sequence: seq
  };
}
function runawayTurn(events: DomainEvent[], turn: number): void {
  events.push(evt("TOOL_CALLED", { toolCall: { toolName: "payment.refund", input: { orderId: "o1" } } }));
  events.push(evt("RETRY_TRIGGERED", { error: `PaymentGatewayError: gateway timeout (txn 7f3a${turn}cd)` }));
  events.push(evt("MODEL_COMPLETED", { output: { plan: "retry refund o1" }, tokenUsage: { total: 6000 } }));
}

const CTX: AnalyzerContext = { executionId: "exec-loop", detectedAt: "2025-11-03T02:14:00.000Z" };
const isHighLoop = (s: FailureSignal): boolean =>
  s.kind === "EXECUTION_LOOP" && (s.severity === "HIGH" || s.severity === "CRITICAL");

describe("demo guardrail 2 — runaway loop", () => {
  beforeEach(() => { seq = 0; });

  it("does not fire on a short, healthy stream", () => {
    const detector = new ExecutionLoopDetector();
    const events: DomainEvent[] = [
      evt("TOOL_CALLED", { toolCall: { toolName: "web.search", input: { q: "a" } } }),
      evt("MODEL_COMPLETED", { output: { plan: "step A" }, tokenUsage: { total: 800 } }),
      evt("EXECUTION_COMPLETED", { execution: { id: "exec-loop" } })
    ];
    expect(detector.analyze(events, undefined, CTX).some(isHighLoop)).toBe(false);
  });

  it("trips with a HIGH+ EXECUTION_LOOP signal within 3 runaway turns", () => {
    const detector = new ExecutionLoopDetector();
    const events: DomainEvent[] = [];
    let trippedAt = 0;
    for (let t = 1; t <= 10 && trippedAt === 0; t++) {
      runawayTurn(events, t);
      if (detector.analyze(events, undefined, CTX).some(isHighLoop)) trippedAt = t;
    }
    expect(trippedAt).toBeGreaterThan(0);
    expect(trippedAt).toBeLessThanOrEqual(3);
  });
});
