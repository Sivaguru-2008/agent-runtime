/**
 * Subprocess code-execution sandbox.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ────────────────────────────────────────────────────────────────────────────
 * The previous `code.execute` tool ran model-authored JavaScript with Node's
 * built-in `node:vm` module *inside the API process*. The Node documentation is
 * explicit that `vm` is NOT a security mechanism: a context created by
 * `vm.createContext` shares the host realm's intrinsics, so the classic gadget
 *
 *     this.constructor.constructor("return process")()
 *
 * recovers the host `process` object and from there `process.getBuiltinModule`,
 * `require`, the filesystem, the network, and every secret in `process.env`
 * (DATABASE_URL, ANTHROPIC_API_KEY, GROQ_API_KEY, …). Because the runtime
 * executes whatever tool calls the *model* emits, a single prompt-injection
 * turns `code.execute` into arbitrary code execution on the API host. That is a
 * critical, untenable production risk.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ISOLATION MODEL (defense in depth)
 * ────────────────────────────────────────────────────────────────────────────
 * Untrusted code now runs in a dedicated, short-lived **child Node process**
 * that is jailed at the OS/runtime level. We assume the in-process `vm`
 * boundary WILL be escaped and make the surrounding process safe regardless:
 *
 *   1. Node Permission Model (`--permission`). Runtime-enforced, cannot be
 *      undone from JavaScript. Denies (verified empirically):
 *        • filesystem read/write           → ERR_ACCESS_DENIED
 *        • child_process spawn/exec        → ERR_ACCESS_DENIED
 *        • worker_threads                  → ERR_ACCESS_DENIED
 *        • native addons / process.dlopen  → ERR_ACCESS_DENIED
 *        • process.binding(...)            → ERR_ACCESS_DENIED
 *      A vm escape that reaches the child's real `process` therefore still
 *      cannot touch the filesystem, spawn a shell, or load native code.
 *
 *   2. Runtime neutralization. Before any untrusted code runs, the child nulls
 *      the residual capability surface the permission model does NOT cover —
 *      principally network module access via `process.getBuiltinModule`
 *      (the permission model has no `--allow-net`). We also delete the network
 *      globals (`fetch`, `WebSocket`, …) and poison `Module._load` for the
 *      socket-capable core modules. With these closed, an escaped `process`
 *      reference yields nothing that can open a socket.
 *
 *   3. Scrubbed environment. The child is spawned with a minimal env containing
 *      NO secrets — even a total escape cannot exfiltrate credentials that were
 *      never handed to the process.
 *
 *   4. Bare `vm` context. Only inert data globals (Math, JSON, …) are injected.
 *      Dynamic `import()` is unavailable (no importModuleDynamically callback),
 *      so the ESM loader cannot be used to reach core modules either.
 *
 *   5. Resource limits:
 *        • memory   — `--max-old-space-size=<MB>` caps the V8 old space; an OOM
 *                     crashes only the child.
 *        • CPU/wall — the `vm` script `timeout` interrupts synchronous busy
 *                     loops; a parent-side SIGKILL backstop guarantees the
 *                     child cannot outlive `timeoutMs + grace` even if it wedges
 *                     the event loop or ignores the vm timeout.
 *        • output   — stdout is capped so a flood cannot exhaust parent memory.
 *
 * Every one of these boundaries is exercised by test/sandbox.escape.test.ts.
 */

import { spawn } from "node:child_process";

export interface SandboxRunOptions {
  /** Wall-clock + vm timeout in milliseconds. */
  timeoutMs: number;
  /** V8 old-space ceiling for the child in megabytes. */
  memoryMb?: number;
  /** Hard cap on captured stdout bytes. */
  maxOutputBytes?: number;
}

export interface SandboxRunResult {
  output: string;
  returnValue?: unknown;
  error?: string;
  timedOut: boolean;
  executionTimeMs: number;
}

const DEFAULT_MEMORY_MB = 128;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
/** Grace added to the vm timeout before the parent force-kills the child. */
const KILL_GRACE_MS = 1_500;

/**
 * The child-process runner, embedded as a string and evaluated via `node -e`.
 *
 * Embedding (rather than shipping a sibling .js file) keeps a single artifact
 * that works identically under `tsx` in dev and compiled `dist/` in prod, and
 * avoids granting the permission model any `--allow-fs-read` at all — there is
 * no script file for the child to read; the source arrives on argv and the
 * untrusted code arrives on stdin.
 *
 * Kept dependency-free and defensively written: it must not throw before it has
 * installed its own error reporting, or the parent would see an opaque crash.
 */
const RUNNER_SOURCE = [
  '"use strict";',
  'const vm = require("node:vm");',
  // ── (2) Runtime neutralization ──────────────────────────────────────────
  // Close the residual capability surface the permission model does not cover.
  // These run in the child's host realm BEFORE any untrusted code, so even a vm',
  // escape that recovers this `process` finds the network doors already nailed.
  "try {",
  '  const Module = require("node:module");',
  '  const BLOCKED = new Set(["net","tls","http","https","http2","dns","dgram","inspector","v8","node:net","node:tls","node:http","node:https","node:http2","node:dns","node:dgram","node:inspector","node:v8"]);',
  "  const origLoad = Module._load;",
  "  Module._load = function (request) {",
  '    if (BLOCKED.has(String(request))) throw new Error("E_SANDBOX_BLOCKED_MODULE:" + request);',
  "    return origLoad.apply(this, arguments);",
  "  };",
  "} catch (e) { /* module hardening best-effort */ }",
  "try { process.getBuiltinModule = undefined; } catch (e) {}",
  "try { process.binding = undefined; } catch (e) {}",
  "try { process._linkedBinding = undefined; } catch (e) {}",
  "try { process.dlopen = undefined; } catch (e) {}",
  "try { delete globalThis.fetch; } catch (e) {}",
  "try { delete globalThis.WebSocket; } catch (e) {}",
  "try { delete globalThis.Request; } catch (e) {}",
  "try { delete globalThis.Response; } catch (e) {}",
  "try { delete globalThis.EventSource; } catch (e) {}",
  // ── Collect untrusted code from stdin ─────────────────────────────────────
  "let buf = '';",
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => { buf += d; });',
  '  process.stdin.on("end", () => {',
  "  const out = [];",
  "  const NL = String.fromCharCode(10);",
  "  const sandboxConsole = {",
  '    log: function () { out.push(Array.prototype.map.call(arguments, String).join(" ")); },',
  '    warn: function () { out.push("[warn] " + Array.prototype.map.call(arguments, String).join(" ")); },',
  '    error: function () { out.push("[error] " + Array.prototype.map.call(arguments, String).join(" ")); },',
  "  };",
  // ── (4) Bare context: inert data globals only ─────────────────────────────
  "  const ctx = vm.createContext({",
  "    console: sandboxConsole,",
  "    Math: Math, JSON: JSON, Array: Array, Object: Object, String: String,",
  "    Number: Number, Boolean: Boolean, Date: Date, RegExp: RegExp, Error: Error,",
  "    Map: Map, Set: Set, Promise: Promise, Symbol: Symbol, BigInt: BigInt,",
  "    parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite,",
  "    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,",
  "  });",
  "  const timeoutMs = Number(process.env.SANDBOX_TIMEOUT_MS) || 5000;",
  "  let rv; let err;",
  "  const finish = function () {",
  "    let serialized;",
  "    try {",
  "      serialized = rv === undefined ? undefined : JSON.parse(JSON.stringify(rv, function (k, v) {",
  '        if (typeof v === "function" || typeof v === "symbol") return undefined;',
  '        if (typeof v === "bigint") return v.toString();',
  "        return v;",
  "      }));",
  "    } catch (e) { serialized = String(rv); }",
  "    try { process.stdout.write(JSON.stringify({ output: out.join(NL), returnValue: serialized, error: err })); }",
  "    catch (e) { process.stdout.write(JSON.stringify({ output: '', error: 'E_SANDBOX_SERIALIZE' })); }",
  "  };",
  "  try {",
  '    rv = new vm.Script(buf, { filename: "agent-sandbox.js" }).runInContext(ctx, { timeout: timeoutMs });',
  "    if (rv instanceof Promise) {",
  "      const timer = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('async timeout')); }, timeoutMs); });",
  "      Promise.race([rv, timer]).then(function (v) { rv = v; finish(); }, function (e) { rv = undefined; err = (e && e.message) ? e.message : String(e); finish(); });",
  "      return;",
  "    }",
  "  } catch (e) { err = (e && e.message) ? e.message : String(e); }",
  "  finish();",
  "});",
].join("\n");

/** Choose the right permission-model flag for the running Node major version. */
function permissionFlag(): string {
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  // `--permission` is stable from Node 23; 20–22 expose it as experimental.
  return major >= 23 ? "--permission" : "--experimental-permission";
}

/**
 * Run untrusted JavaScript in the jailed child process. Never throws for
 * untrusted-code failures — those surface in `result.error`. Throws only for
 * a genuine inability to spawn the sandbox (treated as a tool failure upstream).
 */
export async function runCodeInSandbox(
  code: string,
  options: SandboxRunOptions
): Promise<SandboxRunResult> {
  const memoryMb = options.memoryMb ?? DEFAULT_MEMORY_MB;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const started = Date.now();

  return await new Promise<SandboxRunResult>((resolve) => {
    let settled = false;
    const settle = (r: Omit<SandboxRunResult, "executionTimeMs">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ ...r, executionTimeMs: Date.now() - started });
    };

    let child;
    try {
      child = spawn(
        process.execPath,
        [
          permissionFlag(),
          "--no-warnings",
          `--max-old-space-size=${memoryMb}`,
          "-e",
          RUNNER_SOURCE,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          // (3) Scrubbed environment — NO secrets reach the child. SystemRoot is
          // required for process startup on Windows; the timeout is the only
          // payload. DATABASE_URL / API keys are deliberately absent.
          env: {
            SANDBOX_TIMEOUT_MS: String(options.timeoutMs),
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          },
          windowsHide: true,
        }
      );
    } catch (err) {
      settle({
        output: "",
        error: `sandbox spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs + KILL_GRACE_MS);

    child.stdout.on("data", (d: Buffer) => {
      if (truncated) return;
      stdout += d.toString("utf8");
      if (stdout.length > maxOutputBytes) {
        stdout = stdout.slice(0, maxOutputBytes);
        truncated = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 4_096) stderr += d.toString("utf8");
    });

    child.on("error", (err) => {
      settle({
        output: "",
        error: `sandbox process error: ${err instanceof Error ? err.message : String(err)}`,
        timedOut,
      });
    });

    child.on("close", (exitCode, signal) => {
      if (timedOut) {
        settle({
          output: "",
          error: `code.execute timed out after ${options.timeoutMs}ms`,
          timedOut: true,
        });
        return;
      }
      if (truncated) {
        settle({
          output: stdout,
          error: `code.execute output exceeded ${maxOutputBytes} bytes`,
          timedOut: false,
        });
        return;
      }
      if (!stdout) {
        // No structured result: OOM (SIGABRT/heap), crash, or a permission
        // denial the runner could not catch.
        const reason =
          signal === "SIGKILL"
            ? "sandbox killed (memory or resource limit exceeded)"
            : `sandbox exited without result (code=${exitCode}, signal=${signal ?? "none"})${stderr ? ": " + stderr.slice(0, 200) : ""}`;
        settle({ output: "", error: reason, timedOut: false });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          output?: string;
          returnValue?: unknown;
          error?: string;
        };
        settle({
          output: parsed.output ?? "",
          ...(parsed.returnValue !== undefined ? { returnValue: parsed.returnValue } : {}),
          ...(parsed.error !== undefined ? { error: parsed.error } : {}),
          timedOut: false,
        });
      } catch {
        settle({
          output: "",
          error: "sandbox produced unparseable output",
          timedOut: false,
        });
      }
    });

    // Hand the untrusted code to the child over stdin (avoids env/argv size
    // limits and keeps the permission model from needing any fs grant).
    try {
      child.stdin.write(code, "utf8");
      child.stdin.end();
    } catch {
      child.kill("SIGKILL");
      settle({ output: "", error: "sandbox stdin write failed", timedOut: false });
    }
  });
}
