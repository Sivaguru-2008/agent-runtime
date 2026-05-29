import type { ExecutionRepository } from "../../domain/ports.js";
import type { ToolCallDedupStore } from "../../domain/toolDedup.js";
import type { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import type { EventFactory } from "../../infrastructure/events/eventFactory.js";
import type { Execution } from "../../domain/model.js";
import {
  type ReconciliationContext,
  type ExternalVerificationResult,
  AmbiguityDetectedError,
  isReplaySafeTool
} from "../canonicalSemantics.js";
import { ReconciliationEngine } from "../reconciliation/reconciliationEngine.js";

export class ReconciliationManager {
  public readonly engine: ReconciliationEngine;

  constructor(
    private readonly executions: ExecutionRepository,
    private readonly dedup: ToolCallDedupStore,
    private readonly publisher: PersistedEventPublisher,
    private readonly eventFactory: EventFactory
  ) {
    this.engine = new ReconciliationEngine(executions, dedup, publisher, eventFactory);
  }

  /**
   * Evaluates the ambiguity and attempts automatic verification via the first-class ReconciliationEngine.
   */
  async verifyAndReconcile(
    ctx: ReconciliationContext,
    execution: Execution,
    now: Date
  ): Promise<ExternalVerificationResult> {
    // If the tool is replay-safe/idempotent, we do not need to escalate
    if (isReplaySafeTool(ctx.toolName)) {
      return { status: "NOT_COMMITTED" };
    }

    // Initialize first-class reconciliation record
    const record = this.engine.initiateReconciliation(
      execution.id,
      ctx.idempotencyKey,
      ctx.toolName,
      ctx.args
    );

    // Perform verification polling & retry via engine
    const updatedRecord = await this.engine.reconcile(ctx.idempotencyKey, now);

    if (updatedRecord.status === "RECONCILED_COMMITTED") {
      return {
        status: "COMMITTED",
        output: updatedRecord.output
      };
    }

    if (updatedRecord.status === "RECONCILED_FAILED") {
      return {
        status: "NOT_COMMITTED",
        error: updatedRecord.error
      };
    }

    // Otherwise, it failed to resolve or returned UNKNOWN/RECONCILIATION_REQUIRED
    const error = new AmbiguityDetectedError(ctx, updatedRecord.error ?? `Verification returned ambiguous/uncertain status.`);
    throw error;
  }

  /**
   * Operator escalation resolution endpoint.
   * Manually overrides state and lets execution proceed.
   */
  async operatorResolve(
    executionId: string,
    resolution: "COMMIT" | "ABORT",
    now: Date,
    output?: Record<string, unknown>,
    errorMessage?: string
  ): Promise<Execution> {
    const execution = await this.executions.getById(executionId);
    if (!execution) {
      throw new Error(`Execution ${executionId} not found`);
    }

    if (execution.status !== "RECONCILIATION_REQUIRED" && execution.status !== "AMBIGUOUS") {
      throw new Error(`Execution ${executionId} is not in reconciliation state (status: ${execution.status})`);
    }

    // Find the reconciliation record for this execution
    const records = this.engine.listRecords().filter(r => r.executionId === executionId);

    if (records.length > 0) {
      for (const record of records) {
        await this.engine.operatorOverride(record.idempotencyKey, resolution, now, output, errorMessage);
      }
    } else {
      // Fallback if no records exist: perform the override directly using executionId as key
      this.engine.initiateReconciliation(
        executionId,
        executionId,
        "manual-override",
        {}
      );
      await this.engine.operatorOverride(executionId, resolution, now, output, errorMessage);
    }

    const updated = await this.executions.getById(executionId);
    return updated ?? execution;
  }
}
