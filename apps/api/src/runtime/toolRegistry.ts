/**
 * Real ToolExecutor implementation.
 *
 * Registered tools
 * ────────────────
 * web.search       — HTTP search via DuckDuckGo Instant Answer API (free,
 *                    no key) or Brave Search API when BRAVE_API_KEY is set.
 * file.read        — Sandboxed filesystem read capped at FILE_READ_MAX_BYTES.
 *                    Path must resolve inside FILE_READ_BASE_PATH; traversal
 *                    attempts throw.
 * code.execute     — Runs JS in a jailed child Node process (Permission Model
 *                    + scrubbed env + bare vm context). No filesystem, no
 *                    network, no child processes, no secrets; hard memory and
 *                    wall-clock limits. See runtime/sandbox/subprocessSandbox.ts.
 * memory.summarize — Thin text concatenation (real summarization delegated
 *                    to the model in a future pass).
 * runtime.inspect  — Diagnostic introspection (always available).
 *
 * Operational impact  : each tool call is synchronous from the executor's
 *   perspective but bounded by per-tool timeouts so a hanging web request
 *   never stalls the cognition loop.
 * Replay implications : tool outputs are stored in TOOL_CALLED event payloads;
 *   replay reconstructs the exact result that was returned.
 * Failure modes       : every tool catches its own errors and returns a
 *   structured `{error, reason}` rather than throwing, so the executor can
 *   incorporate the failure into its next model call.
 * Observability       : `durationMs` and `toolName` are always present in the
 *   returned object, surfacing in the execution event log automatically.
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { ToolExecutor } from "../domain/ports.js";
import { throwIfAborted, composeAbortSignals } from "../providers/retry.js";
import { runCodeInSandbox } from "./sandbox/subprocessSandbox.js";
export { isReplaySafeTool, isToolSafe } from "./canonicalSemantics.js";

export interface ToolRegistryConfig {
  /** Brave Search API key. Falls back to DuckDuckGo when absent. */
  braveApiKey?: string;
  /** Root directory file.read is restricted to. Defaults to process.cwd(). */
  fileReadBasePath?: string;
  /** Maximum bytes returned by file.read. Default 32 768. */
  fileReadMaxBytes?: number;
  /** Wall-clock timeout for web.search requests in ms. Default 10 000. */
  webSearchTimeoutMs?: number;
  /** Wall-clock timeout for code.execute in ms. Default 5 000. */
  codeExecuteTimeoutMs?: number;
  /** V8 old-space ceiling for the code.execute child process in MB. Default 128. */
  codeExecuteMemoryMb?: number;
}

type ToolInput = {
  toolName: string;
  args: Record<string, unknown>;
  executionId: string;
  agentId: string;
  signal?: AbortSignal;
  /**
   * Audit CRITICAL-1: deterministic per-call identity used by the dedup
   * wrapper. BuiltInToolExecutor does not consult it directly — the wrapper
   * sits in front and short-circuits before the inner execute() runs.
   * Carried in this type so the structural input from the port matches.
   */
  idempotencyKey?: string;
  attempt?: number;
};

type ToolOutput = Record<string, unknown>;

export class BuiltInToolExecutor implements ToolExecutor {
  private readonly braveApiKey?: string;
  private readonly fileReadBasePath: string;
  private readonly fileReadMaxBytes: number;
  private readonly webSearchTimeoutMs: number;
  private readonly codeExecuteTimeoutMs: number;
  private readonly codeExecuteMemoryMb: number;
  private readonly attemptMap = new Map<string, number>();

  constructor(config: ToolRegistryConfig = {}) {
    this.braveApiKey = config.braveApiKey;
    this.fileReadBasePath = config.fileReadBasePath ?? process.cwd();
    this.fileReadMaxBytes = config.fileReadMaxBytes ?? 32_768;
    this.webSearchTimeoutMs = config.webSearchTimeoutMs ?? 10_000;
    this.codeExecuteTimeoutMs = config.codeExecuteTimeoutMs ?? 5_000;
    this.codeExecuteMemoryMb = config.codeExecuteMemoryMb ?? 128;
  }

  async execute(input: ToolInput): Promise<ToolOutput> {
    throwIfAborted(input.signal);
    const started = Date.now();
    let result: ToolOutput;

    const attemptKey = `${input.executionId}:${input.toolName}`;
    const currentAttempt = (this.attemptMap.get(attemptKey) ?? 0) + 1;
    this.attemptMap.set(attemptKey, currentAttempt);

    try {
      switch (input.toolName) {
        case "web.search":
          result = await this.webSearch(input.args, input.signal);
          break;
        case "file.read":
          result = await this.fileRead(input.args, input.signal);
          break;
        case "code.execute":
          result = await this.codeExecute(input.args, input.signal);
          break;
        case "memory.summarize":
          result = this.memorySummarize(input.args);
          break;
        case "runtime.inspect":
          result = {
            agentId: input.agentId,
            executionId: input.executionId,
            inspectedAt: new Date().toISOString(),
            args: input.args
          };
          break;
        case "sandbox.payment_refund": {
          result = {
            status: "refunded",
            amount: 1200,
            currency: "usd",
            transactionId: "ch_3M991823",
            message: `Stripe payment refund completed successfully on attempt #${currentAttempt}.`
          };
          break;
        }
        case "sandbox.db_write": {
          if (currentAttempt === 1) {
            throw new Error("DB_CONNECTION_TIMEOUT: PostgreSQL connection pool exhausted. Action suspended.");
          }
          result = {
            status: "written",
            rowsAffected: 1,
            ledgerId: "ledger_881923",
            message: `Ledger updated successfully on attempt #${currentAttempt}.`
          };
          break;
        }
        default:
          result = {
            skipped: true,
            reason: `No executor registered for tool "${input.toolName}"`,
            toolName: input.toolName
          };
      }
    } catch (err) {
      result = {
        error: true,
        reason: err instanceof Error ? err.message : String(err),
        toolName: input.toolName
      };
    }

    return { ...result, durationMs: Date.now() - started, toolName: input.toolName };
  }

  // ─── web.search ───────────────────────────────────────────────────────────

  private async webSearch(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutput> {
    const query = String(args.query ?? args.q ?? "");
    if (!query.trim()) return { error: true, reason: "web.search requires a non-empty query" };

    if (this.braveApiKey) {
      return this.braveSearch(query, signal);
    }
    return this.duckDuckGoSearch(query, signal);
  }

  private async braveSearch(query: string, parentSignal?: AbortSignal): Promise<ToolOutput> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.webSearchTimeoutMs);
    
    const { signal: composedSignal, cleanup: cleanupComposition } = composeAbortSignals(parentSignal, ac.signal);

    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "Api-Key": this.braveApiKey!
        },
        signal: composedSignal
      });

      if (!res.ok) return { error: true, reason: `Brave Search HTTP ${res.status}`, query };

      const data = await res.json() as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
      };
      const results = (data.web?.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? ""
      }));

      return { query, provider: "brave", results, resultCount: results.length };
    } finally {
      clearTimeout(t);
      cleanupComposition();
    }
  }

  private async duckDuckGoSearch(query: string, parentSignal?: AbortSignal): Promise<ToolOutput> {
    const url =
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.webSearchTimeoutMs);
    
    const { signal: composedSignal, cleanup: cleanupComposition } = composeAbortSignals(parentSignal, ac.signal);

    try {
      const res = await fetch(url, { signal: composedSignal });
      if (!res.ok) return { error: true, reason: `DuckDuckGo HTTP ${res.status}`, query };

      const data = await res.json() as {
        AbstractText?: string;
        AbstractSource?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
        Results?: Array<{ Text?: string; FirstURL?: string }>;
        Definition?: string;
        DefinitionSource?: string;
      };

      const results: Array<{ title: string; url: string; snippet: string }> = [];

      if (data.AbstractText) {
        results.push({
          title: data.AbstractSource ?? "Abstract",
          url: data.AbstractURL ?? "",
          snippet: data.AbstractText
        });
      }
      if (data.Definition) {
        results.push({
          title: `Definition — ${data.DefinitionSource ?? ""}`,
          url: "",
          snippet: data.Definition
        });
      }
      for (const r of (data.Results ?? []).slice(0, 3)) {
        results.push({ title: r.Text ?? "", url: r.FirstURL ?? "", snippet: r.Text ?? "" });
      }
      for (const r of (data.RelatedTopics ?? []).slice(0, 3)) {
        if (r.Text) {
          results.push({ title: r.Text.slice(0, 80), url: r.FirstURL ?? "", snippet: r.Text });
        }
      }

      return { query, provider: "duckduckgo", results, resultCount: results.length };
    } finally {
      clearTimeout(t);
      cleanupComposition();
    }
  }

  // ─── file.read ────────────────────────────────────────────────────────────

  private async fileRead(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutput> {
    throwIfAborted(signal);
    const rawPath = String(args.path ?? "");
    if (!rawPath) return { error: true, reason: "file.read requires a path argument" };

    // Resolve and validate: must stay inside the allowed base path.
    const resolved = path.resolve(this.fileReadBasePath, rawPath);
    const base = path.resolve(this.fileReadBasePath);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return {
        error: true,
        reason: `file.read: path "${rawPath}" resolves outside the allowed directory`
      };
    }

    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(resolved, "r");
      const stat = await handle.stat();

      if (stat.isDirectory()) {
        const entries = await fs.readdir(resolved);
        return { path: rawPath, type: "directory", entries };
      }

      const maxBytes = Math.min(
        typeof args.maxBytes === "number" ? args.maxBytes : this.fileReadMaxBytes,
        this.fileReadMaxBytes
      );
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      const content = buf.subarray(0, bytesRead).toString("utf8");
      const truncated = stat.size > maxBytes;

      return {
        path: rawPath,
        type: "file",
        content,
        size: stat.size,
        bytesRead,
        truncated
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { error: true, reason: `file.read: "${rawPath}" not found` };
      if (code === "EACCES") return { error: true, reason: `file.read: permission denied for "${rawPath}"` };
      throw err;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  // ─── code.execute ─────────────────────────────────────────────────────────

  private async codeExecute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutput> {
    throwIfAborted(signal);
    const code = String(args.code ?? "");
    if (!code.trim()) return { error: true, reason: "code.execute requires a non-empty code argument" };

    // Cap untrusted source size before it ever leaves the parent: a multi-MB
    // payload is never legitimate model output and only serves to stress the
    // pipe / V8 parser. 256 KiB is generous for tool-authored snippets.
    if (code.length > 256 * 1024) {
      return { error: true, reason: "code.execute: code exceeds 256 KiB limit" };
    }

    const timeoutMs = Math.min(
      typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : this.codeExecuteTimeoutMs,
      this.codeExecuteTimeoutMs
    );

    // Execution happens in a jailed child process (Node Permission Model +
    // scrubbed env + bare vm context). The host realm — and every secret in
    // it — is unreachable even if the in-process vm boundary is escaped. See
    // runtime/sandbox/subprocessSandbox.ts for the threat model and the
    // empirically-verified escape matrix in test/sandbox.escape.test.ts.
    const result = await runCodeInSandbox(code, {
      timeoutMs,
      memoryMb: this.codeExecuteMemoryMb
    });
    throwIfAborted(signal);

    return {
      output: result.output,
      returnValue: result.returnValue,
      error: result.error,
      executionTimeMs: result.executionTimeMs,
      timedOut: result.timedOut
    };
  }

  // ─── memory.summarize ─────────────────────────────────────────────────────

  private memorySummarize(args: Record<string, unknown>): ToolOutput {
    const items = Array.isArray(args.items) ? args.items as unknown[] : [];
    const topic = String(args.topic ?? "");
    const combined = items.map(String).join("\n---\n");
    const wordCount = combined.split(/\s+/).filter(Boolean).length;

    return {
      topic,
      summary: combined.length > 0
        ? `[Memory summary of ${items.length} item(s), ~${wordCount} words]: ${combined.slice(0, 500)}`
        : "No items provided for summarization.",
      itemCount: items.length,
      wordCount
    };
  }
}
