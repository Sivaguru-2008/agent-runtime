export type AgentState = "CREATED" | "IDLE" | "RUNNING" | "STOPPING" | "STOPPED" | "FAILED" | "DEGRADED";
export type RuntimeStatus = "OFFLINE" | "READY" | "BUSY" | "STOPPING" | "ERROR";
export type ExecutionStatus =
  | "CREATION"
  | "SCHEDULING"
  | "LEASE_ACQUISITION"
  | "RUNNING"
  | "SIDE_EFFECT_PENDING"
  | "REPLAYING"
  | "RECOVERING"
  | "COMMITTED"
  | "COMPLETED"
  | "FAILED"
  | "AMBIGUOUS"
  | "RECONCILIATION_REQUIRED"
  | "DEAD_LETTERED"
  | "EXPIRED"
  | "QUEUED"
  | "CANCELLED";
export type ExecutionStepType = "PLANNING" | "MEMORY_RETRIEVAL" | "TOOL_CALL" | "MODEL_GENERATION" | "RETRY" | "COMPLETION";
export type ExecutionStepStatus = "STARTED" | "COMPLETED" | "FAILED";
export type MemoryType = "EPISODIC" | "TASK_HISTORY" | "SEMANTIC_REFERENCE";

export interface ToolConfig {
  name: string;
  description?: string;
  enabled: boolean;
}

export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
}

export interface MemoryPolicy {
  episodicEnabled: boolean;
  semanticEnabled: boolean;
  maxRetrievedItems: number;
}

export interface Agent {
  id: string;
  name: string;
  goal: string;
  state: AgentState;
  runtimeStatus: RuntimeStatus;
  model: ModelConfig;
  tools: ToolConfig[];
  memoryPolicy: MemoryPolicy;
  createdAt: string;
  updatedAt: string;
  /**
   * Owning tenant. Optional on the domain type for backwards compatibility
   * with in-memory test fixtures, but REQUIRED by every postgres repository
   * write — adapters throw if missing under an authenticated persistence path.
   */
  tenantId?: string;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface Execution {
  id: string;
  agentId: string;
  parentExecutionId?: string;
  status: ExecutionStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  failure?: {
    message: string;
    code?: string;
    recoverable: boolean;
  };
  tokenUsage: TokenUsage;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
  /**
   * Owning tenant. Stamped at execution creation in AgentRuntime so every
   * persisted execution row carries the originating tenant for isolation
   * enforcement. Optional on the type for back-compat with replay fixtures.
   */
  tenantId?: string;
  /**
   * Distributed trace correlation id, threaded from the originating request
   * context at execution creation. Optional for back-compat; observability
   * routes fall back to resolving it from the execution's event log when a
   * persisted value is unavailable (e.g. the Postgres executions table predates
   * the column).
   */
  traceId?: string;
}

export interface ExecutionStep {
  id: string;
  executionId: string;
  agentId: string;
  type: ExecutionStepType;
  status: ExecutionStepStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

export interface MemoryRecord {
  id: string;
  agentId: string;
  executionId?: string;
  type: MemoryType;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  /**
   * Owning tenant. Resolved from the owning agent's tenant at memory write
   * time. Required by the postgres repository; optional on the type for
   * compatibility with in-memory unit tests that pre-date tenancy.
   */
  tenantId?: string;
}

export interface ToolCallRecord {
  id: string;
  executionId: string;
  stepId: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: "COMPLETED" | "FAILED";
  durationMs?: number;
  createdAt: string;
}

export interface ReplayExternalityRecord {
  id: string;
  executionId: string;
  stepSequence: number;
  type: string; // PLANNING, MEMORY_RETRIEVAL, TOOL_CALL, MODEL_GENERATION, RETRY, etc.
  timestamp: string;
  
  // Tool inputs/outputs, side-effect metadata
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  sideEffectMetadata?: Record<string, unknown>;
  
  // LLM outputs, provider responses
  prompt?: string;
  llmOutput?: Record<string, unknown>;
  providerResponse?: Record<string, unknown>;
  
  // Randomness seeds, retry/replay metadata
  randomnessSeed?: string;
  retryAttempt?: number;
  retryMetadata?: Record<string, unknown>;
  replayMetadata?: Record<string, unknown>;
}

