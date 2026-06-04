/**
 * Security regression suite for the code.execute sandbox.
 *
 * Proves the subprocess isolation actually contains hostile, escape-attempting
 * code: filesystem, network, child-process, secret exfiltration, and the
 * classic `vm` realm-escape gadget are all neutralized, and resource limits
 * (timeout, output, memory) hold. Each case is the kind of payload a
 * prompt-injected model could emit through the code.execute tool.
 *
 * If any of these assertions ever flips, the sandbox has regressed to an
 * unsafe state and the suite fails the build.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runCodeInSandbox } from "../src/runtime/sandbox/subprocessSandbox.js";
import { BuiltInToolExecutor } from "../src/runtime/toolRegistry.js";

// A fake secret planted in the PARENT environment. The sandbox must never be
// able to read it — the child is spawned with a scrubbed env.
beforeAll(() => {
  process.env.SANDBOX_TEST_SECRET = "super-secret-credential-value";
});

const OPTS = { timeoutMs: 3_000, memoryMb: 64 } as const;

describe("code.execute sandbox — functional", () => {
  it("runs normal code and returns the value", async () => {
    const r = await runCodeInSandbox("1 + 2", OPTS);
    expect(r.error).toBeUndefined();
    expect(r.returnValue).toBe(3);
  });

  it("captures console output and serializes object return values", async () => {
    const r = await runCodeInSandbox("console.log('hello'); ({ ok: true, n: 5 })", OPTS);
    expect(r.error).toBeUndefined();
    expect(r.output).toContain("hello");
    expect(r.returnValue).toEqual({ ok: true, n: 5 });
  });

  it("reports sandbox-internal errors without throwing to the host", async () => {
    const r = await runCodeInSandbox("throw new Error('boom')", OPTS);
    expect(r.error).toContain("boom");
  });
});

describe("code.execute sandbox — filesystem isolation", () => {
  it("blocks direct filesystem reads (require unavailable in context)", async () => {
    const r = await runCodeInSandbox(
      "require('node:fs').readFileSync('package.json', 'utf8')",
      OPTS
    );
    expect(r.returnValue).toBeUndefined();
    expect(r.error).toBeTruthy();
  });

  it("blocks filesystem reads attempted via the vm realm-escape gadget", async () => {
    // Recover the host `process` via the constructor chain, then try fs.
    const payload = `
      const p = this.constructor.constructor("return process")();
      const fs = p.getBuiltinModule ? p.getBuiltinModule("node:fs") : null;
      fs ? fs.readFileSync("package.json", "utf8") : "no-fs-access";
    `;
    const r = await runCodeInSandbox(payload, OPTS);
    // Either getBuiltinModule was neutralized (TypeError) or the permission
    // model denied fs — in NO case do we get file contents back.
    expect(String(r.returnValue ?? "")).not.toContain("dependencies");
    expect(r.error ?? "no-fs-access").not.toContain("agent-platform");
  });
});

describe("code.execute sandbox — network isolation", () => {
  it("removes network globals (fetch/WebSocket)", async () => {
    const r = await runCodeInSandbox(
      "JSON.stringify({ fetch: typeof fetch, ws: typeof WebSocket })",
      OPTS
    );
    expect(r.returnValue).toBe(JSON.stringify({ fetch: "undefined", ws: "undefined" }));
  });

  it("blocks reaching the net module through the escaped process", async () => {
    const payload = `
      const p = this.constructor.constructor("return process")();
      (typeof p.getBuiltinModule === "function")
        ? "GETBUILTIN_AVAILABLE"
        : "getBuiltinModule-neutralized";
    `;
    const r = await runCodeInSandbox(payload, OPTS);
    // getBuiltinModule is the only escape route to node:net under --permission;
    // it must have been nulled by the runner.
    expect(r.returnValue).not.toBe("GETBUILTIN_AVAILABLE");
  });
});

describe("code.execute sandbox — process / secret isolation", () => {
  it("does not expose host secrets via process.env", async () => {
    const payload = `
      const p = this.constructor.constructor("return process")();
      (p && p.env && p.env.SANDBOX_TEST_SECRET) ? p.env.SANDBOX_TEST_SECRET : "no-secret";
    `;
    const r = await runCodeInSandbox(payload, OPTS);
    expect(String(r.returnValue ?? r.output ?? "")).not.toContain("super-secret-credential-value");
  });

  it("blocks child_process spawning", async () => {
    const payload = `
      const p = this.constructor.constructor("return process")();
      try {
        const cp = p.getBuiltinModule("node:child_process");
        cp.execSync("echo pwned").toString();
      } catch (e) { "spawn-blocked:" + (e.code || e.message); }
    `;
    const r = await runCodeInSandbox(payload, OPTS);
    expect(String(r.returnValue ?? "")).not.toContain("pwned");
  });

  it("blocks dynamic import() of core modules", async () => {
    const payload = `this.constructor.constructor("return import('node:fs')")()`;
    const r = await runCodeInSandbox(payload, OPTS);
    expect(r.error).toBeTruthy();
    expect(String(r.returnValue ?? "")).not.toContain("readFileSync");
  });
});

describe("code.execute sandbox — resource limits", () => {
  it("kills synchronous infinite loops via the timeout", async () => {
    const r = await runCodeInSandbox("while (true) {}", { timeoutMs: 600, memoryMb: 64 });
    expect(r.timedOut || /timed out/i.test(r.error ?? "")).toBe(true);
  });

  it("contains runaway memory allocation (OOM kills only the child)", async () => {
    // Allocate well beyond the 32 MB cap; the child must die, the host survives.
    const payload = "const a = []; while (true) { a.push(new Array(1e6).fill(7)); }";
    const r = await runCodeInSandbox(payload, { timeoutMs: 8_000, memoryMb: 32 });
    expect(r.error).toBeTruthy();
    expect(r.returnValue).toBeUndefined();
  }, 15_000);

  it("caps captured stdout to prevent host memory exhaustion", async () => {
    const payload = "for (let i = 0; i < 1e7; i++) console.log('x'.repeat(100));";
    const r = await runCodeInSandbox(payload, { timeoutMs: 5_000, memoryMb: 64, maxOutputBytes: 4096 });
    expect(r.error).toBeTruthy();
    expect(r.output.length).toBeLessThanOrEqual(4096);
  }, 10_000);
});

describe("code.execute sandbox — wired through the tool executor", () => {
  const executor = new BuiltInToolExecutor({ codeExecuteTimeoutMs: 3_000, codeExecuteMemoryMb: 64 });

  it("executes code.execute end-to-end and blocks fs escape", async () => {
    const ok = await executor.execute({
      toolName: "code.execute",
      args: { code: "21 * 2" },
      executionId: "exec-sbx-1",
      agentId: "agent-sbx"
    });
    expect(ok.returnValue).toBe(42);

    const escape = await executor.execute({
      toolName: "code.execute",
      args: { code: "require('node:fs').readFileSync('package.json','utf8')" },
      executionId: "exec-sbx-2",
      agentId: "agent-sbx"
    });
    expect(String(escape.returnValue ?? "")).not.toContain("dependencies");
  });

  it("rejects oversized code payloads before spawning", async () => {
    const huge = "x".repeat(256 * 1024 + 1);
    const r = await executor.execute({
      toolName: "code.execute",
      args: { code: `"${huge}"` },
      executionId: "exec-sbx-3",
      agentId: "agent-sbx"
    });
    expect(r.error).toBe(true);
    expect(String(r.reason)).toContain("256 KiB");
  });
});
