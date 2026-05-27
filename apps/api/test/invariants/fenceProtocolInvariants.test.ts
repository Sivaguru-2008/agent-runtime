/**
 * Fence-protocol invariant suite — docs/specs/fence-protocol.md §B.4.
 *
 * These tests target the executor + store contract using an in-memory
 * `ToolCallDedupStore` fake. The Postgres backing (which enforces I2 at
 * the SQL level via `execution_leases` row-lock + CTE) is exercised in
 * the integration suite; this file is for unit-level coverage of the
 * executor's behaviour under each invariant.
 *
 * Mapping:
 *   I1 — Side-effect uniqueness  (counted inner.execute invocations)
 *   I3 — Reservation precedes side effect  (observed begin-then-invoke order)
 *   I4 — Stale-write blocked  (FENCED outcome → FenceLostError)
 *   I5 — Args stability  (ARG_DRIFT mode → ReplayDivergenceError)
 *
 * I2 (token monotonicity) is a property of the lease store, not the
 * dedup executor; covered by the existing leases concurrency tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DedupingToolExecutor,
  FenceLostError,
  ReplayDivergenceError
} from "../../src/runtime/toolDedupExecutor.js";
import type {
  BeginCallMode,
  FencedMarkOutcome,
  ToolCallDedupBegin,
  ToolCallDedupRecord,
  ToolCallDedupStore
} from "../../src/domain/toolDedup.js";
import type { ToolExecutor } from "../../src/domain/ports.js";

interface FakeRow {
  status: ToolCallDedupRecord["status"];
  output?: Record<string, unknown>;
  argsHash?: string;
  stepSeq?: number;
  fenceTokenAtReserve?: number;
  attempt: number;
}

/**
 * In-memory dedup store that implements both the legacy and fence-aware
 * methods. The `simulate` hooks let each test inject specific outcomes
 * (e.g., force a `FENCED` mark to verify the executor surrenders).
 */
class FakeDedupStore implements ToolCallDedupStore {
  rows = new Map<string, FakeRow>();
  /** When true, every fenced mark returns FENCED instead of COMMITTED. */
  forceFenceLost = false;
  /** Counts of each method invocation, for ordering / call-count assertions. */
  calls = {
    beginCall: 0,
    markCompleted: 0,
    markCompletedFenced: 0,
    markFailed: 0,
    markFailedFenced: 0
  };

  async beginCall(input: ToolCallDedupBegin): Promise<BeginCallMode> {
    this.calls.beginCall++;
    const existing = this.rows.get(input.idempotencyKey);
    if (existing) {
      if (input.argsHash && existing.argsHash && existing.argsHash !== input.argsHash) {
        return {
          mode: "ARG_DRIFT",
          recordedArgsHash: existing.argsHash,
          observedArgsHash: input.argsHash
        };
      }
      if ((existing.status === "SUCCEEDED" || existing.status === "COMPLETED") && existing.output) {
        return { mode: "RETURN_CACHED", output: existing.output };
      }
      if (existing.status === "FAILED") {
        existing.status = "RESERVED";
        existing.output = undefined;
        return { mode: "FIRST_CALL" };
      }
      return { mode: "POLL_FOR_RESULT", sinceMs: 0 };
    }
    this.rows.set(input.idempotencyKey, {
      status: "RESERVED",
      argsHash: input.argsHash,
      stepSeq: input.stepSeq,
      fenceTokenAtReserve: input.fenceTokenAtReserve,
      attempt: input.attempt
    });
    return { mode: "FIRST_CALL" };
  }

  async markCompleted(key: string, output: Record<string, unknown>): Promise<void> {
    this.calls.markCompleted++;
    const r = this.rows.get(key);
    if (r) {
      r.status = "SUCCEEDED";
      r.output = output;
    }
  }

  async markFailed(key: string, err: string): Promise<void> {
    this.calls.markFailed++;
    const r = this.rows.get(key);
    if (r) r.status = "FAILED";
    void err;
  }

  async markCompletedFenced(input: {
    idempotencyKey: string;
    executionId: string;
    expectedFencingToken: number;
    output: Record<string, unknown>;
  }): Promise<FencedMarkOutcome> {
    this.calls.markCompletedFenced++;
    if (this.forceFenceLost) return { outcome: "FENCED" };
    const r = this.rows.get(input.idempotencyKey);
    if (!r) return { outcome: "FENCED" };
    r.status = "SUCCEEDED";
    r.output = input.output;
    return { outcome: "COMMITTED" };
  }

  async markFailedFenced(input: {
    idempotencyKey: string;
    executionId: string;
    expectedFencingToken: number;
    errorMessage: string;
  }): Promise<FencedMarkOutcome> {
    this.calls.markFailedFenced++;
    if (this.forceFenceLost) return { outcome: "FENCED" };
    const r = this.rows.get(input.idempotencyKey);
    if (!r) return { outcome: "FENCED" };
    r.status = "FAILED";
    void input.errorMessage;
    return { outcome: "COMMITTED" };
  }

  async get(key: string): Promise<ToolCallDedupRecord | undefined> {
    const r = this.rows.get(key);
    if (!r) return undefined;
    return {
      idempotencyKey: key,
      executionId: "exec",
      agentId: "agent",
      toolName: "fake",
      attempt: r.attempt,
      status: r.status,
      output: r.output,
      createdAt: new Date().toISOString(),
      tenantId: "system",
      ...(r.argsHash ? { argsHash: r.argsHash } : {}),
      ...(r.stepSeq !== undefined ? { stepSeq: r.stepSeq } : {}),
      ...(r.fenceTokenAtReserve !== undefined ? { fenceTokenAtReserve: r.fenceTokenAtReserve } : {})
    };
  }

  async getByStep(executionId: string, stepSeq: number): Promise<ToolCallDedupRecord | undefined> {
    for (const [key, r] of this.rows.entries()) {
      if (r.stepSeq === stepSeq) return this.get(key);
      void executionId;
    }
    return undefined;
  }
}

/**
 * Counting inner executor. The wrapped DedupingToolExecutor should only
 * invoke this when it has reserved the dedup slot. Each invocation is
 * counted so I1 (side-effect uniqueness) can be asserted.
 */
class CountingTool implements ToolExecutor {
  invocations = 0;
  order: string[] = [];
  shouldThrow: Error | null = null;
  output: Record<string, unknown> = { ok: true };

  async execute(input: Parameters<ToolExecutor["execute"]>[0]): Promise<Record<string, unknown>> {
    this.invocations++;
    this.order.push(`invoke:${input.idempotencyKey}`);
    if (this.shouldThrow) throw this.shouldThrow;
    return this.output;
  }
}

function makeExecutor(store: FakeDedupStore, tool: CountingTool) {
  return new DedupingToolExecutor(tool, store, {
    pollIntervalMs: 1,
    pollTimeoutMs: 50,
    resolveTenantId: () => "t1"
  });
}

const baseInput = {
  toolName: "fake-tool",
  args: { x: 1 },
  executionId: "exec-1",
  agentId: "agent-1",
  idempotencyKey: "k1",
  attempt: 7,
  stepSeq: 3,
  argsHash: "hash-A"
};

describe("fence-protocol invariants", () => {
  let store: FakeDedupStore;
  let tool: CountingTool;
  let exec: DedupingToolExecutor;

  beforeEach(() => {
    store = new FakeDedupStore();
    tool = new CountingTool();
    exec = makeExecutor(store, tool);
  });

  describe("I3 — Reservation precedes side effect", () => {
    it("calls beginCall before inner.execute on first call", async () => {
      const seen: string[] = [];
      const wrappedStore = new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === "beginCall") {
            return async (...args: [ToolCallDedupBegin]) => {
              seen.push("beginCall");
              return Reflect.get(target, prop, receiver).apply(target, args);
            };
          }
          return Reflect.get(target, prop, receiver);
        }
      });
      const e2 = new DedupingToolExecutor(
        {
          execute: async (i) => {
            seen.push(`invoke:${i.idempotencyKey}`);
            return { ok: true };
          }
        },
        wrappedStore,
        { resolveTenantId: () => "t1" }
      );
      await e2.execute(baseInput);
      expect(seen[0]).toBe("beginCall");
      expect(seen[1]).toBe("invoke:k1");
    });
  });

  describe("I1 — Side-effect uniqueness", () => {
    it("returns cached output on second call without invoking the tool again", async () => {
      const a = await exec.execute(baseInput);
      const b = await exec.execute(baseInput);
      expect(a).toEqual(b);
      // The tool runs exactly once across both retries — that's the
      // invariant the fence protocol exists to enforce.
      expect(tool.invocations).toBe(1);
    });

    it("a sibling poll that finds SUCCEEDED returns cached without re-invoking", async () => {
      // First call lands SUCCEEDED.
      await exec.execute(baseInput);
      // Mark the slot SUCCEEDED (the first call already did this). A
      // second logical caller using the same key should not re-invoke.
      const before = tool.invocations;
      await exec.execute({ ...baseInput, attempt: 8 }); // different attempt, same key
      expect(tool.invocations).toBe(before);
    });
  });

  describe("I4 — Stale-write blocked", () => {
    it("FENCED markCompletedFenced surrenders with FenceLostError", async () => {
      store.forceFenceLost = true;
      await expect(exec.execute(baseInput)).rejects.toBeInstanceOf(FenceLostError);
      // The tool was invoked once (we did the side effect); we then lost
      // the lease and surrendered. The dedup row stays RESERVED for the
      // new owner to converge on. The remote dedupes their retry.
      expect(tool.invocations).toBe(1);
      expect(store.calls.markCompletedFenced).toBe(1);
      // The non-fenced path MUST NOT have been used as a fallback.
      expect(store.calls.markCompleted).toBe(0);
    });

    it("falls back to non-fenced mark when fence-aware methods are unavailable", async () => {
      // Strip the fenced methods to simulate a legacy in-memory store.
      const legacyStore: ToolCallDedupStore = {
        beginCall: store.beginCall.bind(store),
        markCompleted: store.markCompleted.bind(store),
        markFailed: store.markFailed.bind(store),
        get: store.get.bind(store)
      };
      const legacy = new DedupingToolExecutor(tool, legacyStore, {
        resolveTenantId: () => "t1"
      });
      await legacy.execute(baseInput);
      expect(store.calls.markCompleted).toBe(1);
      expect(store.calls.markCompletedFenced).toBe(0);
    });
  });

  describe("I5 — Args stability (replay divergence)", () => {
    it("ARG_DRIFT throws ReplayDivergenceError and does NOT invoke the tool", async () => {
      // First reserve records args_hash = hash-A.
      await store.beginCall({
        idempotencyKey: "k1",
        executionId: "exec-1",
        agentId: "agent-1",
        toolName: "fake-tool",
        attempt: 1,
        tenantId: "t1",
        stepSeq: 3,
        argsHash: "hash-A"
      });
      // Second call carries a different args_hash.
      const drifted = { ...baseInput, argsHash: "hash-B" };
      await expect(exec.execute(drifted)).rejects.toBeInstanceOf(ReplayDivergenceError);
      // The tool MUST NOT have been invoked under drifted args.
      expect(tool.invocations).toBe(0);
    });

    it("matching args_hash on retry is not a divergence", async () => {
      await exec.execute(baseInput);
      // Same hash, same key → return cached, no second invocation.
      await exec.execute(baseInput);
      expect(tool.invocations).toBe(1);
    });
  });

  describe("fence-aware path selection", () => {
    it("uses markCompletedFenced when attempt is set and store implements it", async () => {
      await exec.execute(baseInput);
      expect(store.calls.markCompletedFenced).toBe(1);
      expect(store.calls.markCompleted).toBe(0);
    });

    it("uses markFailedFenced on tool error when fence-aware", async () => {
      tool.shouldThrow = new Error("boom");
      await expect(exec.execute(baseInput)).rejects.toThrow("boom");
      expect(store.calls.markFailedFenced).toBe(1);
      expect(store.calls.markFailed).toBe(0);
    });
  });
});
