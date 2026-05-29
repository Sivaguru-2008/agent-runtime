/**
 * DedupingToolExecutor + FenceProtocol integration suite.
 *
 * Proves that, when a FenceProtocol is wired, the executor routes every
 * external side effect through the explicit fence state machine: the tool is
 * invoked exactly once, only while the fence is EXECUTING (F1), retries return
 * the cached commit (F3/F6), stale workers surrender (F4), arg drift and
 * ambiguity short-circuit before any dispatch (F6/S3).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DedupingToolExecutor,
  FenceLostError,
  ReplayDivergenceError
} from "../../src/runtime/toolDedupExecutor.js";
import { NoopToolCallDedupStore } from "../../src/runtime/toolDedupExecutor.js";
import { InMemoryFenceStore } from "../../src/infrastructure/persistence/inMemoryFenceStore.js";
import { FenceProtocol } from "../../src/runtime/fence/fenceProtocol.js";
import {
  AmbiguityDetectedError,
  sideEffectCapabilityRegistry
} from "../../src/runtime/canonicalSemantics.js";
import type { ToolExecutor } from "../../src/domain/ports.js";

class CountingTool implements ToolExecutor {
  invocations = 0;
  shouldThrow: Error | null = null;
  output: Record<string, unknown> = { ok: true };
  /** Optional probe run inside execute() to observe live fence state. */
  onInvoke?: () => void | Promise<void>;

  async execute(): Promise<Record<string, unknown>> {
    this.invocations++;
    if (this.onInvoke) await this.onInvoke();
    if (this.shouldThrow) throw this.shouldThrow;
    return this.output;
  }
}

const KEY = "exec-7:5";

function callInput(over: Record<string, unknown> = {}) {
  return {
    toolName: "stripe.refund",
    args: { amount: 100 },
    executionId: "exec-7",
    agentId: "agent-1",
    idempotencyKey: KEY,
    attempt: 1,
    stepSeq: 5,
    argsHash: "hashA",
    workerId: "w1",
    ...over
  };
}

describe("fence-guarded executor", () => {
  let store: InMemoryFenceStore;
  let fence: FenceProtocol;
  let tool: CountingTool;
  let exec: DedupingToolExecutor;

  beforeEach(() => {
    // CAP1: every tool routed through the executor must declare a capability
    // class. A refund is a non-idempotent external side effect — exactly the
    // kind of call the fence protocol exists to guard.
    sideEffectCapabilityRegistry.register("stripe.refund", "NON_IDEMPOTENT");
    store = new InMemoryFenceStore();
    fence = new FenceProtocol(store);
    tool = new CountingTool();
    exec = new DedupingToolExecutor(tool, new NoopToolCallDedupStore(), {
      fence,
      defaultWorkerId: "w-default",
      resolveTenantId: () => "t1"
    });
  });

  it("fires the side effect once and commits the fence", async () => {
    const out = await exec.execute(callInput());
    expect(out).toEqual({ ok: true });
    expect(tool.invocations).toBe(1);
    const rec = await store.get(KEY);
    expect(rec?.state).toBe("COMMITTED");
    expect(rec?.output).toEqual({ ok: true });
  });

  it("F1 — the tool is invoked only while the fence is EXECUTING", async () => {
    let stateAtInvoke: string | undefined;
    tool.onInvoke = async () => {
      stateAtInvoke = (await store.get(KEY))?.state;
    };
    await exec.execute(callInput());
    expect(stateAtInvoke).toBe("EXECUTING");
  });

  it("a retry returns the cached commit without re-invoking the tool (F3/F6)", async () => {
    await exec.execute(callInput());
    const again = await exec.execute(callInput({ attempt: 2, workerId: "w2" }));
    expect(again).toEqual({ ok: true });
    expect(tool.invocations).toBe(1);
  });

  it("F4 — a stale worker surrenders with FenceLostError and never invokes the tool", async () => {
    // A newer owner (attempt 2) has already reserved the fence.
    await fence.reserveOrResolve({
      fenceId: KEY,
      executionId: "exec-7",
      stepSeq: 5,
      tenantId: "t1",
      toolName: "stripe.refund",
      idempotencyKey: KEY,
      argsHash: "hashA",
      owner: { workerId: "w2", attempt: 2 }
    });
    await expect(exec.execute(callInput({ attempt: 1 }))).rejects.toBeInstanceOf(FenceLostError);
    expect(tool.invocations).toBe(0);
  });

  it("F6 — drifted args surface as ReplayDivergenceError, no dispatch", async () => {
    await exec.execute(callInput({ argsHash: "hashA" }));
    await expect(
      exec.execute(callInput({ argsHash: "hashB", attempt: 2, workerId: "w2" }))
    ).rejects.toBeInstanceOf(ReplayDivergenceError);
    expect(tool.invocations).toBe(1); // only the first (committed) call ran
  });

  it("S3 — an orphaned in-flight fence surfaces ambiguity, no blind re-dispatch", async () => {
    // Worker 1 began the side effect and "crashed" (EXECUTING, never committed).
    await fence.reserveOrResolve({
      fenceId: KEY,
      executionId: "exec-7",
      stepSeq: 5,
      tenantId: "t1",
      toolName: "stripe.refund",
      idempotencyKey: KEY,
      argsHash: "hashA",
      owner: { workerId: "w1", attempt: 1 }
    });
    await fence.beginSideEffect({ fenceId: KEY, claimant: { workerId: "w1", attempt: 1 } });

    // Worker 2 recovers and runs the step; ambiguity must be surfaced.
    await expect(
      exec.execute(callInput({ attempt: 2, workerId: "w2" }))
    ).rejects.toBeInstanceOf(AmbiguityDetectedError);
    expect(tool.invocations).toBe(0);
    expect((await store.get(KEY))?.state).toBe("AMBIGUOUS");
  });

  it("a tool error records FAILED on the fence and rethrows", async () => {
    tool.shouldThrow = new Error("upstream 500");
    await expect(exec.execute(callInput())).rejects.toThrow("upstream 500");
    const rec = await store.get(KEY);
    expect(rec?.state).toBe("FAILED");
    expect(rec?.error).toContain("upstream 500");
  });

  it("a FAILED fence is re-opened and re-run on a fresh attempt", async () => {
    tool.shouldThrow = new Error("transient");
    await expect(exec.execute(callInput())).rejects.toThrow("transient");
    expect(tool.invocations).toBe(1);

    // Retry on a new attempt: FAILED is restartable, so the tool runs again.
    tool.shouldThrow = null;
    const out = await exec.execute(callInput({ attempt: 2, workerId: "w2" }));
    expect(out).toEqual({ ok: true });
    expect(tool.invocations).toBe(2);
    expect((await store.get(KEY))?.state).toBe("COMMITTED");
  });

  it("falls back to the legacy path when no fence coordinates are present", async () => {
    // No stepSeq/argsHash/attempt ⇒ legacy dedup path (NoopToolCallDedupStore),
    // which forwards transparently. The fence store stays empty.
    const out = await exec.execute({
      toolName: "web.search",
      args: { q: "x" },
      executionId: "exec-7",
      agentId: "agent-1",
      idempotencyKey: "legacy-key"
    });
    expect(out).toEqual({ ok: true });
    expect(store.snapshot()).toHaveLength(0);
  });
});
