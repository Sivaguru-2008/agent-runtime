import {
  type SideEffectCapability,
  sideEffectCapabilityRegistry,
  assertRuntimeInvariant
} from "./canonicalSemantics.js";
import { TOOL_REPLAY_POLICIES, ReplayPolicyViolationError } from "./replay/replaySandbox.js";

export class IdempotencyPolicyEnforcer {
  /**
   * Asserts and retrieves a tool's capability class.
   * CAP1: Every registered tool must have an explicit capability declaration.
   */
  static getValidatedCapability(toolName: string): SideEffectCapability {
    const capability = sideEffectCapabilityRegistry.get(toolName);
    assertRuntimeInvariant(
      "CAP1",
      capability !== undefined,
      `Missing capability declaration for tool '${toolName}'. Every integration must declare its capability class.`
    );
    return capability!;
  }

  /**
   * Validates if a tool call is safe to run.
   */
  static validateExecutionSafety(
    toolName: string,
    context: {
      hasFence: boolean;
      operatorApproved?: boolean;
    }
  ): void {
    const cap = this.getValidatedCapability(toolName);

    // UNSAFE requires operator approval
    if (cap === "UNSAFE") {
      assertRuntimeInvariant(
        "CAP2",
        context.operatorApproved === true,
        `Unsafe execution blocked: tool '${toolName}' is classified as UNSAFE and requires operator approval.`
      );
    }

    // CONDITIONALLY_IDEMPOTENT requires fence verification
    if (cap === "CONDITIONALLY_IDEMPOTENT") {
      assertRuntimeInvariant(
        "S2",
        context.hasFence,
        `Fence verification required: tool '${toolName}' is classified as CONDITIONALLY_IDEMPOTENT and must be executed within a valid durable fence context.`
      );
    }
  }

  /**
   * Validates safety during replay execution.
   */
  static validateReplaySafety(
    toolName: string,
    context: {
      diverged: boolean;
      operatorApproved?: boolean;
    }
  ): void {
    const policy = TOOL_REPLAY_POLICIES[toolName] ?? "BLOCKED_REPLAY";

    if (policy === "BLOCKED_REPLAY") {
      const id = context.diverged ? "RP1" : "CAP3";
      throw new ReplayPolicyViolationError(
        `Replay Side-Effect Mutex violation: cannot execute unsafe side-effect '${toolName}' of capability class '${this.getValidatedCapability(toolName)}' after replay divergence.`,
        id
      );
    }

    if (policy === "MANUAL_REPLAY_REQUIRED" && !context.operatorApproved) {
      throw new ReplayPolicyViolationError(
        `Replay policy violation: tool '${toolName}' is classified as MANUAL_REPLAY_REQUIRED and requires operator approval.`
      );
    }

    const cap = this.getValidatedCapability(toolName);

    // Replay must NEVER bypass UNSAFE restrictions
    if (cap === "UNSAFE") {
      assertRuntimeInvariant(
        "CAP2",
        context.operatorApproved === true,
        `Unsafe replay execution blocked: tool '${toolName}' is classified as UNSAFE and requires operator approval.`
      );
    }

    if (context.diverged) {
      // CAP3 / RP1: after divergence, non-safe tools are strictly prohibited from execution
      assertRuntimeInvariant(
        "RP1",
        cap === "SAFE_IDEMPOTENT" || policy === "SIMULATED_REPLAY" || (policy === "MANUAL_REPLAY_REQUIRED" && context.operatorApproved === true),
        `Replay Side-Effect Mutex violation: cannot execute side effect '${toolName}' of capability class '${cap}' after replay divergence.`
      );
    } else {
      // Before divergence, we must never blindly execute NON_IDEMPOTENT or UNSAFE live.
      // If they are not replayed from cache (meaning a live execution is attempted), block it!
      assertRuntimeInvariant(
        "CAP3",
        cap === "SAFE_IDEMPOTENT" || cap === "CONDITIONALLY_IDEMPOTENT" || policy === "SIMULATED_REPLAY" || (policy === "MANUAL_REPLAY_REQUIRED" && context.operatorApproved === true),
        `Unsafe replay execution: cannot run live execution of side effect '${toolName}' of capability class '${cap}' during deterministic replay.`
      );
    }
  }

  /**
   * Validates retry policy legality before scheduling.
   */
  static validateRetrySafety(
    toolName: string,
    context: {
      reconciled?: boolean;
      operatorApproved?: boolean;
    }
  ): void {
    const cap = this.getValidatedCapability(toolName);

    if (cap === "UNSAFE") {
      assertRuntimeInvariant(
        "CAP2",
        context.operatorApproved === true,
        `Unsafe retry blocked: tool '${toolName}' is classified as UNSAFE and requires operator approval.`
      );
    }

    if (cap === "NON_IDEMPOTENT") {
      assertRuntimeInvariant(
        "CAP4",
        context.reconciled === true,
        `Invalid retry policy: tool '${toolName}' is NON_IDEMPOTENT and cannot be retried without reconciliation.`
      );
    }
  }
}
