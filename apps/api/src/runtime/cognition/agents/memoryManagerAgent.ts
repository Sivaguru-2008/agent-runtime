import type { RoleAgent, RoleContext, RoleResult } from "../roles.js";
import type { MemoryRepository } from "../../../domain/ports.js";
import type { Clock } from "../../../shared/clock.js";
import { toIso } from "../../../shared/clock.js";
import { deterministicId } from "../../../shared/determinism.js";

/**
 * Memory Manager: commits a summarized cognition outcome to long-term memory.
 * Deterministic memory ID — replays do not create duplicate records.
 */
export class MemoryManagerAgent implements RoleAgent {
  readonly role = "MEMORY_MANAGER" as const;

  constructor(
    private readonly memory: MemoryRepository,
    private readonly clock: Clock
  ) {}

  async invoke(context: RoleContext): Promise<RoleResult> {
    const summary = this.summarize(context);
    const id = deterministicId([context.cognitionId, "memory-commit", summary]);
    await this.memory.add({
      id,
      agentId: context.agentId,
      executionId: context.executionId,
      type: "TASK_HISTORY",
      content: summary,
      metadata: {
        cognitionId: context.cognitionId,
        sourceRole: "MEMORY_MANAGER",
        contextNodeCount: context.history.length
      },
      createdAt: toIso(this.clock.now()),
      // C-1: stamp tenantId from the cognition context so the postgres
      // memory repository writes the correct tenant_id rather than rejecting
      // the row or silently coercing to 'system'.
      tenantId: context.tenantId
    });
    return {
      output: { committed: true, memoryId: id, summary },
      uncertainty: { overall: 0.05, variance: 0, lowConfidenceTokens: 0 },
      nextPhase: "COMPLETE",
      reason: "memory-committed"
    };
  }

  private summarize(context: RoleContext): string {
    const goal = context.goal.slice(0, 120);
    let lastModel: typeof context.history[number] | undefined;
    for (let i = context.history.length - 1; i >= 0; i--) {
      if (context.history[i].role === "EXECUTOR") {
        lastModel = context.history[i];
        break;
      }
    }
    const outputPreview = lastModel?.output ? JSON.stringify(lastModel.output).slice(0, 180) : "";
    return `[cognition] goal=${goal} | exec=${outputPreview}`;
  }
}
