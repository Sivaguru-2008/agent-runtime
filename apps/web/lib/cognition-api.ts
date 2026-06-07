/**
 * Sprint Next API client — cognition, replay, time-travel, failure intelligence.
 * Shares the API_BASE convention with apps/web/lib/api.ts.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/runtime";

export class CognitionApiError extends Error {
  public status: number;
  public runtimeId?: string;
  public payloadShape?: string;
  public degradedState?: "CORRUPTED_MEMORY" | "MEMORY_SIGNATURE_DIVERGED" | "EXECUTION_DEGRADED" | "PARTIAL_CONTEXT_RECOVERY";

  constructor(
    message: string,
    status: number,
    options?: {
      runtimeId?: string;
      payloadShape?: string;
      degradedState?: "CORRUPTED_MEMORY" | "MEMORY_SIGNATURE_DIVERGED" | "EXECUTION_DEGRADED" | "PARTIAL_CONTEXT_RECOVERY";
    }
  ) {
    super(message);
    this.name = "CognitionApiError";
    this.status = status;
    this.runtimeId = options?.runtimeId;
    this.payloadShape = options?.payloadShape;
    this.degradedState = options?.degradedState;
    Object.setPrototypeOf(this, CognitionApiError.prototype);
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fetch with bounded retry on transient upstream failures (network error or
 * 5xx). Opt-in via request()'s `retryOn5xx`, and used ONLY for read-only calls:
 * during a local backend restart the durable API briefly 5xx's (or the proxy
 * returns 503), which would otherwise surface as a scary INTERNAL_ERROR card for
 * a sub-second blip. Mutating calls never opt in, so a retry cannot double-submit
 * a side effect.
 */
async function fetchWithRetry(url: string, init: RequestInit, retries: number): Promise<Response> {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && attempt < retries) {
        attempt++;
        await delay(300 * attempt);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < retries) {
        attempt++;
        await delay(300 * attempt);
        continue;
      }
      throw err;
    }
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  opts?: { retryOn5xx?: number }
): Promise<T> {
  let response: Response;
  try {
    // Only advertise a JSON body when one is actually sent. A bodyless POST
    // (e.g. full-analysis, which POSTs with no payload) carrying
    // `Content-Type: application/json` makes the backend's JSON body parser
    // reject the empty body — Fastify raises FST_ERR_CTP_EMPTY_JSON_BODY in the
    // parsing phase, before the route handler runs, which surfaced to the Root
    // Cause panel as the opaque `INTERNAL_ERROR (500): Unexpected runtime error`.
    const hasBody = init?.body !== undefined && init?.body !== null;
    response = await fetchWithRetry(
      `${API_BASE}${path}`,
      {
        ...init,
        headers: {
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          ...init?.headers
        },
        cache: "no-store"
      },
      opts?.retryOn5xx ?? 0
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("[COGNITION_API_FAILURE]", {
      status: 500,
      errorMessage: `Network error: ${errorMsg}`,
      runtimeId: undefined,
      payloadShape: "NETWORK_FAILURE",
      degradedState: undefined
    });
    throw new CognitionApiError(`Network error: ${errorMsg}`, 500, {
      payloadShape: "NETWORK_FAILURE"
    });
  }

  const runtimeId = response.headers.get("x-runtime-id") || undefined;

  if (!response.ok) {
    let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
    let degradedState: CognitionApiError["degradedState"] = undefined;
    let payloadShape = "UNKNOWN";
    let errorBody: any = null;

    try {
      const text = await response.text();
      payloadShape = text ? (text.startsWith("{") ? "JSON" : text.startsWith("<") ? "HTML" : "TEXT") : "EMPTY";
      if (text && payloadShape === "JSON") {
        errorBody = JSON.parse(text);
        if (errorBody && typeof errorBody === "object") {
          payloadShape = `KEYS:${Object.keys(errorBody).join(",")}`;
          if (errorBody.message) {
            errorMessage = `${errorBody.error ?? "Error"} (${response.status}): ${errorBody.message}`;
          } else if (errorBody.error) {
            errorMessage = `API Error (${response.status}): ${errorBody.error}`;
          }
          if (errorBody.issues && Array.isArray(errorBody.issues)) {
            const issuesStr = errorBody.issues.map((i: any) => i.message || JSON.stringify(i)).join(", ");
            errorMessage += ` - Issues: ${issuesStr}`;
          }
          const checkState = errorBody.degradedState || errorBody.error || errorBody.message;
          if (typeof checkState === "string") {
            if (checkState.includes("CORRUPTED_MEMORY")) degradedState = "CORRUPTED_MEMORY";
            else if (checkState.includes("MEMORY_SIGNATURE_DIVERGED")) degradedState = "MEMORY_SIGNATURE_DIVERGED";
            else if (checkState.includes("EXECUTION_DEGRADED")) degradedState = "EXECUTION_DEGRADED";
            else if (checkState.includes("PARTIAL_CONTEXT_RECOVERY")) degradedState = "PARTIAL_CONTEXT_RECOVERY";
          }
        }
      } else if (text && text.length < 200) {
        errorMessage += ` - ${text}`;
      }
    } catch {
      payloadShape = "PARSING_FAILED";
    }

    console.warn("[COGNITION_API_FAILURE]", {
      status: response.status,
      errorMessage,
      runtimeId,
      payloadShape,
      degradedState
    });

    throw new CognitionApiError(errorMessage, response.status, {
      runtimeId,
      payloadShape,
      degradedState
    });
  }

  let text = "";
  try {
    text = await response.text();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("[COGNITION_API_FAILURE]", {
      status: response.status,
      errorMessage: `Failed to read response body text: ${errorMsg}`,
      runtimeId,
      payloadShape: "BODY_READ_FAILED",
      degradedState: undefined
    });
    throw new CognitionApiError(`Body read error: ${errorMsg}`, response.status, {
      runtimeId,
      payloadShape: "BODY_READ_FAILED"
    });
  }

  if (!text || text.trim() === "") {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("[COGNITION_API_FAILURE]", {
      status: response.status,
      errorMessage: `Malformed JSON payload: ${errorMsg}`,
      runtimeId,
      payloadShape: "MALFORMED_JSON",
      degradedState: undefined
    });
    throw new CognitionApiError(`JSON parse error: ${errorMsg}`, response.status, {
      runtimeId,
      payloadShape: "MALFORMED_JSON"
    });
  }
}

// --- Sanitizers for degraded memory paths and safe React rendering ---

function sanitizeCognitionNode(n: any): CognitionNode {
  if (!n || typeof n !== "object") {
    return {
      id: "",
      cognitionId: "",
      executionId: "",
      sequence: 0,
      role: "PLANNER",
      phase: "INIT",
      status: "PENDING",
      input: {},
      startedAt: new Date().toISOString()
    };
  }
  return {
    ...n,
    id: n.id ?? "",
    cognitionId: n.cognitionId ?? "",
    executionId: n.executionId ?? "",
    sequence: n.sequence ?? 0,
    role: n.role ?? "PLANNER",
    phase: n.phase ?? "INIT",
    status: n.status ?? "PENDING",
    input: n.input && typeof n.input === "object" ? n.input : {},
    tokenStream: Array.isArray(n.tokenStream) ? n.tokenStream : undefined,
    uncertainty: n.uncertainty && typeof n.uncertainty === "object" ? n.uncertainty : undefined,
    memoryInfluence: Array.isArray(n.memoryInfluence) ? n.memoryInfluence : undefined,
    startedAt: n.startedAt ?? new Date().toISOString()
  };
}

function sanitizeCognitionGraph(g: any): CognitionGraph {
  if (!g || typeof g !== "object") {
    return {
      id: "",
      executionId: "",
      agentId: "",
      phase: "INIT",
      startedAt: new Date().toISOString(),
      nodes: [],
      handoffs: []
    };
  }
  return {
    ...g,
    id: g.id ?? "",
    executionId: g.executionId ?? "",
    agentId: g.agentId ?? "",
    phase: g.phase ?? "INIT",
    startedAt: g.startedAt ?? new Date().toISOString(),
    nodes: Array.isArray(g.nodes) ? g.nodes.map(sanitizeCognitionNode) : [],
    handoffs: Array.isArray(g.handoffs) ? g.handoffs : []
  };
}

function sanitizeFailureSignal(s: any): FailureSignal {
  if (!s || typeof s !== "object") {
    return {
      id: "",
      executionId: "",
      kind: "PLAN_DRIFT",
      severity: "INFO",
      score: 0,
      summary: "",
      evidence: [],
      detectedAt: new Date().toISOString(),
      detectedBy: ""
    };
  }
  return {
    ...s,
    id: s.id ?? "",
    executionId: s.executionId ?? "",
    kind: s.kind ?? "PLAN_DRIFT",
    severity: s.severity ?? "INFO",
    score: s.score ?? 0,
    summary: s.summary ?? "",
    evidence: Array.isArray(s.evidence) ? s.evidence : [],
    detectedAt: s.detectedAt ?? new Date().toISOString(),
    detectedBy: s.detectedBy ?? ""
  };
}

function sanitizeFailureTimeline(t: any): FailureTimeline {
  if (!t || typeof t !== "object") {
    return {
      executionId: "",
      frames: [],
      totalSignals: 0,
      firstFailureFrameIndex: null,
      hotspotFrameIndex: null,
      healthCurve: []
    };
  }
  return {
    ...t,
    executionId: t.executionId ?? "",
    frames: Array.isArray(t.frames) ? t.frames.map((f: any) => ({
      ...f,
      frameIndex: f.frameIndex ?? 0,
      eventSequence: f.eventSequence ?? 0,
      eventType: f.eventType ?? "",
      label: f.label ?? "",
      tone: f.tone ?? "neutral",
      signals: Array.isArray(f.signals) ? f.signals.map(sanitizeFailureSignal) : [],
      causalRole: f.causalRole ?? "CLEAN"
    })) : [],
    totalSignals: t.totalSignals ?? 0,
    firstFailureFrameIndex: t.firstFailureFrameIndex !== undefined ? t.firstFailureFrameIndex : null,
    hotspotFrameIndex: t.hotspotFrameIndex !== undefined ? t.hotspotFrameIndex : null,
    healthCurve: Array.isArray(t.healthCurve) ? t.healthCurve : []
  };
}

// --- types mirrored from backend, kept narrow for the UI ---

export type AgentRole = "PLANNER" | "EXECUTOR" | "VERIFIER" | "CRITIC" | "MEMORY_MANAGER";
export type CognitionPhase =
  | "INIT"
  | "PLAN"
  | "EXECUTE"
  | "VERIFY"
  | "CRITIQUE"
  | "MEMORY_COMMIT"
  | "COMPLETE"
  | "FAILED";

export interface TokenChunk {
  sequence: number;
  text: string;
  confidence: number;
  emittedAt: string;
}

export interface UncertaintyScore {
  overall: number;
  variance: number;
  lowConfidenceTokens: number;
  selfReport?: number;
}

export interface MemoryInfluence {
  memoryId: string;
  weight: number;
  reason?: string;
}

export interface CognitionNode {
  id: string;
  cognitionId: string;
  executionId: string;
  parentNodeId?: string;
  sequence: number;
  role: AgentRole;
  phase: CognitionPhase;
  status: "PENDING" | "RUNNING" | "STREAMING" | "COMPLETED" | "FAILED" | "SKIPPED" | "REPLAYED";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  tokenStream?: TokenChunk[];
  uncertainty?: UncertaintyScore;
  memoryInfluence?: MemoryInfluence[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  replayedFromNodeId?: string;
}

export interface AgentHandoff {
  fromNodeId: string;
  toRole: AgentRole;
  reason: string;
  carryOver: Record<string, unknown>;
}

export interface CognitionGraph {
  id: string;
  executionId: string;
  agentId: string;
  parentCognitionId?: string;
  parentNodeId?: string;
  /** Distributed trace correlation id, persisted at cognition creation. */
  traceId?: string;
  phase: CognitionPhase;
  startedAt: string;
  completedAt?: string;
  output?: Record<string, unknown>;
  nodes: CognitionNode[];
  handoffs: AgentHandoff[];
}

export interface ReplayFrame {
  index: number;
  kind: "EVENT" | "SNAPSHOT" | "BRANCH_POINT" | "TERMINATION";
  timestamp: string;
  eventSequence: number;
  eventType: string;
  preview: {
    aggregateType: string;
    aggregateId: string;
    label: string;
    tone: "info" | "success" | "warning" | "error" | "neutral";
    fingerprint?: string;
  };
  snapshotId?: string;
}

export interface ReplaySession {
  id: string;
  cognitionId: string;
  executionId: string;
  /** Deterministic trace id for this replay session. */
  traceId?: string;
  /** Runtime correlation id of the request that produced the session. */
  runtimeId?: string;
  status: "READY" | "PLAYING" | "PAUSED" | "ENDED";
  cursor: { frameIndex: number; eventSequence: number; speed: number };
  frames: ReplayFrame[];
  forkedFrom?: { sessionId: string; frameIndex: number };
  createdAt: string;
}

export interface BranchPointer {
  branchCognitionId: string;
  sourceCognitionId: string;
  sourceNodeId: string;
  branchPointFrameIndex: number;
  createdAt: string;
}

export interface FailureSignal {
  id: string;
  cognitionId?: string;
  executionId: string;
  nodeId?: string;
  kind:
    | "HALLUCINATION"
    | "CONTRADICTION"
    | "RECURSION"
    | "TOOL_MISUSE"
    | "CORRUPTED_MEMORY"
    | "UNCERTAINTY_SPIKE"
    | "PLAN_DRIFT";
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  score: number;
  summary: string;
  evidence: Array<{ eventSequence?: number; nodeId?: string; snippet?: string; metric?: Record<string, number> }>;
  detectedAt: string;
  detectedBy: string;
}

export interface FailureReport {
  cognitionId?: string;
  executionId: string;
  totalSignals: number;
  bySeverity: Record<string, number>;
  byKind: Record<string, number>;
  topSignals: FailureSignal[];
  healthScore: number;
}

export interface CognitionGraphView {
  graph: CognitionGraph;
  lineage: Array<{ nodeId: string; cognitionId: string; ancestors: string[]; descendants: string[]; siblings: string[] }>;
  branches: BranchPointer[];
  failureSignals: FailureSignal[];
  uncertainty: { overall: number; variance: number; lowConfidenceTokens: number; nodeCount: number };
  /** Distributed trace id for the cognition (resolved server-side). */
  traceId?: string;
  /** Runtime correlation id of the request that produced this view. */
  runtimeId?: string;
}

export interface MemoryInfluenceHeatmap {
  cognitionId: string;
  memories: Array<{
    memoryId: string;
    aggregateWeight: number;
    nodeContribution: number;
    isAnchor: boolean;
    contentPreview?: string;
  }>;
  cells: Array<{ memoryId: string; nodeId: string; role: string; weight: number }>;
  nodes: Array<{ nodeId: string; role: string; sequence: number }>;
}

export interface ReplayDiff {
  divergenceFrameIndex: number | null;
  deltas: Array<{
    frameIndex: number;
    kind: "IDENTICAL" | "DIVERGED" | "BRANCH_ONLY" | "SOURCE_ONLY";
    sourceFingerprint?: string;
    branchFingerprint?: string;
    field?: string;
    note?: string;
  }>;
  summary: {
    framesCompared: number;
    framesIdentical: number;
    framesDiverged: number;
    branchOnlyFrames: number;
    sourceOnlyFrames: number;
  };
}

export interface CognitionListItem {
  id: string;
  executionId: string;
  agentId: string;
  phase: CognitionPhase;
  startedAt: string;
  completedAt?: string;
  nodeCount: number;
  parentCognitionId?: string;
  hasFailureSignals: boolean;
}

// --- Phase 6: Replay Experience types ---

export interface AnnotatedFrame {
  frameIndex: number;
  eventSequence: number;
  eventType: string;
  label: string;
  tone: "info" | "success" | "warning" | "error" | "neutral";
  signals: FailureSignal[];
  causalRole: "ROOT_CAUSE" | "PROPAGATION" | "TERMINAL" | "CLEAN";
}

export interface FailureTimeline {
  cognitionId?: string;
  executionId: string;
  frames: AnnotatedFrame[];
  totalSignals: number;
  firstFailureFrameIndex: number | null;
  hotspotFrameIndex: number | null;
  healthCurve: Array<{ bucketStart: number; healthScore: number }>;
}

export interface CausalLink {
  nodeId?: string;
  role?: string;
  causalRole: "ROOT_CAUSE" | "PROPAGATION" | "TERMINAL";
  description: string;
  eventSequence?: number;
}

export interface CausalChain {
  signalId: string;
  cognitionId?: string;
  executionId: string;
  links: CausalLink[];
  rootCauseDescription: string;
  rootCauseFrameIndex?: number;
  tracedAt: string;
}

export interface ConfidenceTracePoint {
  nodeId: string;
  sequence: number;
  role: string;
  uncertaintyOverall: number;
  uncertaintyVariance: number;
  lowConfidenceTokens: number;
  selfReport?: number;
  durationMs?: number;
}

export interface ConfidenceTrace {
  cognitionId: string;
  nodeCount: number;
  averageUncertainty: number;
  peakUncertainty: number;
  peakAtNodeId?: string;
  trace: ConfidenceTracePoint[];
}

export interface BranchComparisonEntry {
  branchCognitionId: string;
  sourceCognitionId: string;
  healthScore: number;
  nodeCount: number;
  failureCount: number;
  divergenceFrameIndex?: number;
  recommendedWinner?: boolean;
}

export interface BranchComparison {
  sourceCognitionId: string;
  branches: BranchComparisonEntry[];
  recommendedBranchId?: string;
}

export interface CognitionDiff {
  sourceCognitionId: string;
  branchCognitionId: string;
  firstDivergentNodeSequence?: number;
  divergentNodeCount: number;
  identicalNodeCount: number;
  addedHandoffs: number;
  removedHandoffs: number;
  interpretation: string;
}

export interface FullAnalysisResult {
  executionId: string;
  cognitionId?: string;
  report: FailureReport;
  timeline: FailureTimeline | null;
  topCausality: CausalChain | null;
  branchCount: number;
  suggestBranch: boolean;
  branchSuggestion: string | null;
}

export interface NamedCheckpoint {
  id: string;
  cognitionId: string;
  frameIndex: number;
  name: string;
  note?: string;
  sessionId?: string;
  createdAt: string;
}

export const cognitionApi = {
  startCognition: async (payload: { agentId: string; goal: string; task?: Record<string, unknown>; seed?: string }) => {
    const res = await request<CognitionGraph>("/cognition", { method: "POST", body: JSON.stringify(payload) });
    return sanitizeCognitionGraph(res);
  },
  list: async (limit = 25) => {
    const res = await request<CognitionListItem[]>(`/cognition?limit=${limit}`);
    return Array.isArray(res) ? res : [];
  },
  get: async (cognitionId: string) => {
    const res = await request<CognitionGraphView>(`/cognition/${cognitionId}`);
    const graph = sanitizeCognitionGraph(res?.graph);
    return {
      graph,
      lineage: Array.isArray(res?.lineage) ? res.lineage : [],
      branches: Array.isArray(res?.branches) ? res.branches : [],
      failureSignals: Array.isArray(res?.failureSignals) ? res.failureSignals.map(sanitizeFailureSignal) : [],
      uncertainty: res?.uncertainty ?? { overall: 0, variance: 0, lowConfidenceTokens: 0, nodeCount: 0 },
      traceId: res?.traceId ?? graph.traceId,
      runtimeId: res?.runtimeId
    };
  },
  getNodeDetails: async (cognitionId: string, nodeId: string) => {
    const res = await request<CognitionNode>(`/cognition/${cognitionId}/nodes/${nodeId}`);
    return sanitizeCognitionNode(res);
  },
  failureReport: async (cognitionId: string) => {
    const res = await request<FailureReport>(`/cognition/${cognitionId}/failure-report`);
    return {
      executionId: res?.executionId ?? "",
      totalSignals: res?.totalSignals ?? 0,
      bySeverity: res?.bySeverity ?? {},
      byKind: res?.byKind ?? {},
      topSignals: Array.isArray(res?.topSignals) ? res.topSignals.map(sanitizeFailureSignal) : [],
      healthScore: res?.healthScore ?? 100
    };
  },
  memoryInfluence: async (cognitionId: string) => {
    const res = await request<MemoryInfluenceHeatmap>(`/cognition/${cognitionId}/memory-influence`);
    return {
      cognitionId: res?.cognitionId ?? "",
      memories: Array.isArray(res?.memories) ? res.memories : [],
      cells: Array.isArray(res?.cells) ? res.cells : [],
      nodes: Array.isArray(res?.nodes) ? res.nodes : []
    };
  },

  // Replay
  listFrames: async (cognitionId: string) => {
    const res = await request<ReplayFrame[]>(`/cognition/${cognitionId}/replay/frames`);
    return Array.isArray(res) ? res : [];
  },
  createReplaySession: (cognitionId: string) =>
    request<ReplaySession>(`/cognition/${cognitionId}/replay`, { method: "POST" }),
  getReplaySession: async (sessionId: string) => {
    const res = await request<{ session: ReplaySession; graphAtCursor?: CognitionGraph; snapshots: unknown[] }>(
      `/replay/${sessionId}`
    );
    return {
      session: res?.session,
      graphAtCursor: res?.graphAtCursor ? sanitizeCognitionGraph(res.graphAtCursor) : undefined,
      snapshots: Array.isArray(res?.snapshots) ? res.snapshots : []
    };
  },
  seekReplay: (sessionId: string, frameIndex: number) =>
    request<ReplaySession>(`/replay/${sessionId}/seek`, {
      method: "POST",
      body: JSON.stringify({ frameIndex })
    }),
  playReplay: (sessionId: string, speed: number) =>
    request<ReplaySession>(`/replay/${sessionId}/play`, {
      method: "POST",
      body: JSON.stringify({ speed })
    }),
  snapshotAtFrame: (sessionId: string, frameIndex: number) =>
    request(`/replay/${sessionId}/snapshot`, { method: "POST", body: JSON.stringify({ frameIndex }) }),
  branchFromNode: (payload: {
    sourceCognitionId: string;
    sourceNodeId: string;
    reason?: string;
    overrides?: { seed?: string; model?: string; input?: Record<string, unknown> };
  }) => request<BranchPointer>("/replay/branch", { method: "POST", body: JSON.stringify(payload) }),
  diff: (source: string, branch: string) =>
    request<ReplayDiff>(`/replay/diff?source=${encodeURIComponent(source)}&branch=${encodeURIComponent(branch)}`),

  // Phase 6: Failure timeline with annotated frames + health curve
  getFailureTimeline: async (cognitionId: string) => {
    const res = await request<FailureTimeline>(`/cognition/${cognitionId}/failure-timeline`);
    return sanitizeFailureTimeline(res);
  },

  // Phase 6: Causality chain for a specific failure signal
  getCausalityChain: async (signalId: string) => {
    const res = await request<CausalChain>(`/failure-signals/${signalId}/causality`);
    return {
      signalId: res?.signalId ?? "",
      executionId: res?.executionId ?? "",
      links: Array.isArray(res?.links) ? res.links : [],
      rootCauseDescription: res?.rootCauseDescription ?? "",
      tracedAt: res?.tracedAt ?? ""
    };
  },

  // Phase 6: Per-node confidence degradation trace
  getConfidenceTrace: async (cognitionId: string) => {
    const res = await request<ConfidenceTrace>(`/cognition/${cognitionId}/confidence-trace`);
    return {
      cognitionId: res?.cognitionId ?? "",
      nodeCount: res?.nodeCount ?? 0,
      averageUncertainty: res?.averageUncertainty ?? 0,
      peakUncertainty: res?.peakUncertainty ?? 0,
      trace: Array.isArray(res?.trace) ? res.trace : []
    };
  },

  // Phase 6: Ranked branch comparison with health scores
  getBranchComparison: async (cognitionId: string) => {
    const res = await request<BranchComparison>(`/cognition/${cognitionId}/branch-comparison`);
    return {
      sourceCognitionId: res?.sourceCognitionId ?? "",
      branches: Array.isArray(res?.branches) ? res.branches : []
    };
  },

  // Phase 6: Structural diff explaining WHY two cognitions diverged
  getCognitionDiff: (source: string, branch: string) =>
    request<CognitionDiff>(`/replay/cognition-diff?source=${encodeURIComponent(source)}&branch=${encodeURIComponent(branch)}`),

  // Phase 6: Lineage (ancestors/descendants/siblings) for nodes in a cognition
  getLineage: async (cognitionId: string) => {
    const res = await request<CognitionGraphView["lineage"]>(`/cognition/${cognitionId}/lineage`);
    return Array.isArray(res) ? res : [];
  },

  // Phase 6: Named operator checkpoints
  listCheckpoints: async (cognitionId: string) => {
    const res = await request<NamedCheckpoint[]>(`/cognition/${cognitionId}/checkpoints`);
    return Array.isArray(res) ? res : [];
  },

  createCheckpoint: (cognitionId: string, frameIndex: number, name: string, note?: string, sessionId?: string) =>
    request<NamedCheckpoint>(`/cognition/${cognitionId}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ frameIndex, name, note, sessionId })
    }),

  // Phase 6: Full analysis — analyze + timeline + causality in one call
  runFullAnalysis: async (executionId: string) => {
    // Read-only call (the route is read-only): retry transient 5xx/503 from a
    // backend restart so a sub-second blip doesn't render a hard INTERNAL_ERROR.
    const res = await request<FullAnalysisResult>(
      `/executions/${executionId}/full-analysis`,
      { method: "POST" },
      { retryOn5xx: 2 }
    );
    return {
      executionId: res?.executionId ?? "",
      cognitionId: res?.cognitionId,
      report: res?.report ?? { totalSignals: 0, bySeverity: {}, byKind: {}, topSignals: [], healthScore: 100 },
      timeline: res?.timeline ? sanitizeFailureTimeline(res.timeline) : null,
      topCausality: res?.topCausality ?? null,
      branchCount: res?.branchCount ?? 0,
      suggestBranch: !!res?.suggestBranch,
      branchSuggestion: res?.branchSuggestion ?? null
    };
  }
};
