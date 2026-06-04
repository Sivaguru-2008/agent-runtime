/**
 * Prompt-injection containment suite for ToolPolicyExecutor.
 *
 * Proves that the policy gate denies dangerous / malformed / oversized tool
 * calls before they reach the underlying executor — i.e. the model cannot
 * authorize tools merely by requesting them. Covers both the capability
 * baseline (UNSAFE always denied) and strict allowlist mode.
 */

import { describe, it, expect, vi } from "vitest";
import { ToolPolicyExecutor } from "../src/runtime/toolPolicyExecutor.js";
import { sideEffectCapabilityRegistry } from "../src/runtime/canonicalSemantics.js";
import type { ToolExecutor } from "../src/domain/ports.js";

function makeInner(): ToolExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async execute(input) {
      calls.push(input.toolName);
      return { ok: true, toolName: input.toolName };
    }
  };
}

const capabilityOf = (name: string) => sideEffectCapabilityRegistry.get(name);

function call(name: string, args: Record<string, unknown> = {}) {
  return { toolName: name, args, executionId: "exec-1", agentId: "agent-1" };
}

describe("ToolPolicyExecutor — capability baseline (no allowlist)", () => {
  it("permits safe tools and forwards to the inner executor", async () => {
    const inner = makeInner();
    const policy = new ToolPolicyExecutor(inner, { capabilityOf });
    for (const t of ["web.search", "file.read", "code.execute", "memory.summarize", "runtime.inspect"]) {
      const r = await policy.execute(call(t));
      expect(r.denied).toBeUndefined();
    }
    expect(inner.calls).toHaveLength(5);
  });

  it("denies UNSAFE-capability tools even though the model requested them", async () => {
    const inner = makeInner();
    const onDeny = vi.fn();
    const policy = new ToolPolicyExecutor(inner, { capabilityOf, onDeny });
    for (const t of ["stripe.payment", "aws.infrastructure", "infrastructure.mutate", "operator.restart"]) {
      const r = await policy.execute(call(t, { action: "do harm" }));
      expect(r.error).toBe(true);
      expect(r.denied).toBe(true);
      expect(String(r.reason)).toContain("not permitted");
    }
    expect(inner.calls).toHaveLength(0); // none reached the executor
    expect(onDeny).toHaveBeenCalledTimes(4);
  });

  it("permits NON_IDEMPOTENT / CONDITIONALLY_IDEMPOTENT tools (they are fenced, not blocked)", async () => {
    const inner = makeInner();
    const policy = new ToolPolicyExecutor(inner, { capabilityOf });
    for (const t of ["sandbox.db_write", "sandbox.payment_refund", "email.send", "slack.post"]) {
      const r = await policy.execute(call(t));
      expect(r.denied).toBeUndefined();
    }
    expect(inner.calls).toHaveLength(4);
  });
});

describe("ToolPolicyExecutor — strict allowlist mode", () => {
  it("permits only allowlisted tools and denies everything else", async () => {
    const inner = makeInner();
    const policy = new ToolPolicyExecutor(inner, {
      capabilityOf,
      allowlist: ["web.search", "file.read"]
    });
    expect((await policy.execute(call("web.search"))).denied).toBeUndefined();
    expect((await policy.execute(call("file.read"))).denied).toBeUndefined();
    // code.execute is SAFE but NOT on the allowlist → denied.
    const r = await policy.execute(call("code.execute"));
    expect(r.denied).toBe(true);
    expect(String(r.reason)).toContain("allowlist");
    expect(inner.calls).toEqual(["web.search", "file.read"]);
  });
});

describe("ToolPolicyExecutor — input sanitization", () => {
  const policy = new ToolPolicyExecutor(makeInner(), { capabilityOf });

  it("rejects malformed / injection-shaped tool names", () => {
    expect(policy.evaluate("", {})).toMatch(/malformed/);
    expect(policy.evaluate("rm -rf /", {})).toMatch(/malformed/);
    expect(policy.evaluate("../../etc/passwd", {})).toMatch(/malformed/);
    expect(policy.evaluate("a".repeat(200), {})).toMatch(/malformed/);
    expect(policy.evaluate(123 as unknown, {})).toMatch(/malformed/);
  });

  it("rejects non-object and oversized arguments", () => {
    expect(policy.evaluate("web.search", "not-an-object")).toMatch(/must be a JSON object/);
    expect(policy.evaluate("web.search", [1, 2, 3])).toMatch(/must be a JSON object/);
    const huge = { blob: "x".repeat(100 * 1024) };
    expect(policy.evaluate("web.search", huge)).toMatch(/exceed/);
  });

  it("permits a well-formed safe call", () => {
    expect(policy.evaluate("web.search", { query: "weather" })).toBeNull();
    expect(policy.evaluate("web.search", undefined)).toBeNull();
  });
});
