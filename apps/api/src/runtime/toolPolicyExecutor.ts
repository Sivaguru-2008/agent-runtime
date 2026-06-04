/**
 * Tool execution policy enforcement — prompt-injection containment.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREAT
 * ────────────────────────────────────────────────────────────────────────────
 * The runtime executes whatever tool calls the *model* emits (see
 * ExecutorAgent: it parses `toolCalls` out of model JSON and dispatches each to
 * the ToolExecutor). A prompt-injection — hostile text in a task, a retrieved
 * memory, a web.search result, or a prior tool output — can make the model
 * request ANY tool with ANY arguments. Without a policy gate, an injected
 * instruction such as
 *
 *     {"toolCalls":[{"name":"aws.infrastructure","args":{"action":"terminate"}}]}
 *
 * would flow straight through to a side-effecting executor. The model is an
 * untrusted control-plane input; tool authorization MUST NOT depend on it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POLICY (enforced on EVERY tool call, all execution paths)
 * ────────────────────────────────────────────────────────────────────────────
 * This wrapper sits OUTERMOST in the executor chain (outside dedup, metrics,
 * circuit breaker, and the built-in executor), so a rejected call never
 * reserves a fence, writes a dedup row, or produces any side effect. It is the
 * single chokepoint shared by ExecutionEngine and ExecutorAgent.
 *
 *   1. Name sanitization. The tool name must be a short string matching a
 *      strict charset. Garbage / injection-shaped names are rejected outright.
 *   2. Capability deny-list (always on). Any tool classified `UNSAFE` in the
 *      SideEffectCapabilityRegistry (stripe.payment, aws.infrastructure,
 *      infrastructure.mutate, operator.restart, …) is denied unless explicitly
 *      granted. UNSAFE means "irreversible real-world effect, never replay-safe"
 *      — exactly the class an attacker wants and an autonomous agent should
 *      never reach without an out-of-band human grant.
 *   3. Allowlist (opt-in, strict). When a non-empty allowlist is configured
 *      (TOOL_ALLOWLIST), ONLY listed tools may run; everything else is denied.
 *      This is the recommended production posture.
 *   4. Argument validation/sanitization. Args must be a plain object whose
 *      canonical JSON size is bounded; oversized or non-object args are
 *      rejected before reaching the tool.
 *
 * Denials are returned as structured `{ error, denied, reason }` outputs (never
 * thrown) so the cognition loop incorporates the refusal into its next model
 * call — the agent is told "no" rather than crashing.
 */

import type { ToolExecutor } from "../domain/ports.js";
import type { SideEffectCapability } from "./canonicalSemantics.js";

type ToolInput = Parameters<ToolExecutor["execute"]>[0];
type ToolOutput = Awaited<ReturnType<ToolExecutor["execute"]>>;

export interface ToolPolicyOptions {
  /**
   * When non-empty, ONLY these tool names may execute (strict allowlist mode).
   * When empty/omitted, the capability deny-list baseline applies instead.
   */
  allowlist?: Iterable<string>;
  /**
   * Capabilities that are always denied regardless of allowlist. Defaults to
   * {"UNSAFE"} — the irreversible, never-replay-safe class.
   */
  denyCapabilities?: Iterable<SideEffectCapability>;
  /** Resolve a tool's declared side-effect capability. */
  capabilityOf: (toolName: string) => SideEffectCapability | undefined;
  /** Maximum canonical-JSON byte size of tool args. Default 64 KiB. */
  maxArgsBytes?: number;
  /** Observability hook fired on every denial (audit / metrics). */
  onDeny?: (info: { toolName: string; reason: string; executionId: string }) => void;
}

// Tool names are stable identifiers (namespace.action). Reject anything that
// looks like an injection attempt or path/command fragment.
const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/;
const DEFAULT_MAX_ARGS_BYTES = 64 * 1024;

export class ToolPolicyError extends Error {
  readonly code = "TOOL_POLICY_DENIED";
  constructor(
    readonly toolName: string,
    readonly reason: string
  ) {
    super(`Tool '${toolName}' denied by policy: ${reason}`);
  }
}

export class ToolPolicyExecutor implements ToolExecutor {
  private readonly allowlist: ReadonlySet<string>;
  private readonly strict: boolean;
  private readonly denyCaps: ReadonlySet<SideEffectCapability>;
  private readonly capabilityOf: (toolName: string) => SideEffectCapability | undefined;
  private readonly maxArgsBytes: number;
  private readonly onDeny?: ToolPolicyOptions["onDeny"];

  constructor(
    private readonly inner: ToolExecutor,
    opts: ToolPolicyOptions
  ) {
    this.allowlist = new Set(opts.allowlist ?? []);
    this.strict = this.allowlist.size > 0;
    this.denyCaps = new Set(opts.denyCapabilities ?? (["UNSAFE"] as SideEffectCapability[]));
    this.capabilityOf = opts.capabilityOf;
    this.maxArgsBytes = opts.maxArgsBytes ?? DEFAULT_MAX_ARGS_BYTES;
    this.onDeny = opts.onDeny;
  }

  async execute(input: ToolInput): Promise<ToolOutput> {
    const denial = this.evaluate(input.toolName, input.args);
    if (denial) {
      this.onDeny?.({ toolName: String(input.toolName), reason: denial, executionId: input.executionId });
      return {
        error: true,
        denied: true,
        reason: `Tool '${input.toolName}' is not permitted: ${denial}`,
        toolName: input.toolName
      };
    }
    return this.inner.execute(input);
  }

  /**
   * Returns a denial reason string, or `null` when the call is permitted.
   * Pure and side-effect-free so it is directly unit-testable.
   */
  evaluate(toolName: unknown, args: unknown): string | null {
    if (typeof toolName !== "string" || !TOOL_NAME_RE.test(toolName)) {
      return "malformed or unrecognized tool name";
    }

    // Strict allowlist mode wins: anything not explicitly listed is denied,
    // even if it would otherwise pass the capability check.
    if (this.strict && !this.allowlist.has(toolName)) {
      return "tool is not on the configured allowlist";
    }

    const capability = this.capabilityOf(toolName);
    if (capability !== undefined && this.denyCaps.has(capability)) {
      return `capability '${capability}' is denied to autonomous execution`;
    }

    // Argument validation. Args must be a plain object and bounded in size.
    if (args === undefined || args === null) return null; // empty args ok
    if (typeof args !== "object" || Array.isArray(args)) {
      return "tool arguments must be a JSON object";
    }
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(args), "utf8");
    } catch {
      return "tool arguments are not serializable";
    }
    if (size > this.maxArgsBytes) {
      return `tool arguments exceed ${this.maxArgsBytes} bytes`;
    }
    return null;
  }
}
