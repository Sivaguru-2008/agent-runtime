import type {
  AgentRole,
  CognitionNode,
  CognitionPhase,
  MemoryInfluence,
  TokenChunk,
  UncertaintyScore
} from "../../domain/cognition.js";
import type { MemoryRecord } from "../../domain/model.js";

/**
 * Shared role-agent contract. Each role consumes a context bundle and emits
 * a structured output + an uncertainty score + optional memory influence.
 *
 * Role agents are pure functions over their inputs (plus the model provider)
 * — this is what makes deterministic replay viable.
 */
export interface RoleContext {
  cognitionId: string;
  executionId: string;
  agentId: string;
  goal: string;
  task: Record<string, unknown>;
  seed: string;
  history: CognitionNode[];
  memories: MemoryRecord[];
  /** Carry-over from the previous role, e.g. plan from Planner. */
  carryOver: Record<string, unknown>;
  /**
   * Owning tenant for the cognition. Threaded by the orchestrator so role
   * agents that write to the memory repository can stamp tenant_id on the
   * MemoryRecord (the postgres adapter rejects writes without it).
   */
  tenantId?: string;
}

export interface RoleResult {
  output: Record<string, unknown>;
  /** Optional streamed tokens — used to drive the streaming overlay. */
  tokens?: TokenChunk[];
  uncertainty: UncertaintyScore;
  memoryInfluence?: MemoryInfluence[];
  /** Phase to transition the state machine into after this role completes. */
  nextPhase: CognitionPhase;
  /** Optional hand-off override (else state machine routes by phase). */
  nextRole?: AgentRole;
  /** Free-text reason — surfaces in handoff events. */
  reason?: string;
}

export interface RoleAgent {
  role: AgentRole;
  invoke(context: RoleContext): Promise<RoleResult>;
}
