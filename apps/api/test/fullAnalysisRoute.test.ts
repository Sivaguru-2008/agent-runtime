import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSprintNextRoutes } from "../src/interfaces/http/sprintNextRoutes.js";
import {
  createPermissiveTenantGuard,
  CrossTenantAccessError,
  ResourceTenantNotResolvableError,
  type TenantGuard
} from "../src/infrastructure/security/tenantGuard.js";
import { FailureIntelligenceEngine } from "../src/runtime/failure/failureIntelligenceEngine.js";
import type { RuntimeContainer } from "../src/application/runtimeContainer.js";
import type { FailureSignal, FailureSeverity } from "../src/domain/failure.js";
import type { ReplayFrame } from "../src/domain/replay.js";
import type { CognitionGraph, CognitionNode, AgentRole } from "../src/domain/cognition.js";

/**
 * ROUTE-LEVEL regression suite for GET|POST /executions/:id/full-analysis.
 *
 * The original incident: the handler ran the entire analysis pipeline
 * (analyzeExecution → materializeFrames → FailureTimelineBuilder.build →
 * CausalityTracer.trace → branch lookup) with NO internal error isolation.
 * A throw in ANY stage — a signal whose `evidence` array was absent, a node
 * missing its `inputFingerprint`, a transient store read failure — escaped the
 * handler, hit the global catch-all, and surfaced to the operator dashboard as
 * `INTERNAL_ERROR (500): Unexpected runtime error` (console [COGNITION_API_FAILURE]).
 *
 * The existing `fullAnalysisPipeline.test.ts` proves each STAGE FUNCTION degrades
 * in isolation, but nothing proved the HTTP ROUTE returns 200 — i.e. that the
 * handler wires those stages so no throw can escape and the response always
 * serializes. This suite closes that gap: it drives the real route through
 * `app.inject`, runs the real timeline/causality builders, and forces each
 * stage to throw, asserting the endpoint NEVER returns 500.
 */

const NOW_ISO = "2024-01-01T00:00:00.000Z";
const ADMIN_TENANT = {
  tenantId: "system",
  apiKeyId: "test",
  role: "admin" as const,
  rateLimitRpm: Number.MAX_SAFE_INTEGER
};

function makeSignal(overrides: Partial<FailureSignal> = {}): FailureSignal {
  return {
    id: overrides.id ?? "sig-1",
    cognitionId: overrides.cognitionId ?? "cog-1",
    executionId: overrides.executionId ?? "exec-1",
    nodeId: overrides.nodeId,
    kind: overrides.kind ?? "HALLUCINATION",
    severity: overrides.severity ?? "HIGH",
    score: overrides.score ?? 0.9,
    summary: overrides.summary ?? "synthetic signal",
    evidence: overrides.evidence ?? [{ eventSequence: 0 }],
    detectedAt: overrides.detectedAt ?? NOW_ISO,
    detectedBy: overrides.detectedBy ?? "test"
  };
}

function makeFrame(index: number, overrides: Partial<ReplayFrame> = {}): ReplayFrame {
  return {
    index,
    kind: "EVENT",
    timestamp: NOW_ISO,
    eventSequence: overrides.eventSequence ?? index,
    eventType: overrides.eventType ?? "COGNITION_NODE_COMPLETED",
    preview: overrides.preview ?? {
      aggregateType: "EXECUTION",
      aggregateId: "exec-1",
      label: `frame ${index}`,
      tone: "neutral"
    },
    ...overrides
  };
}

function makeNode(opts: Partial<CognitionNode> & { sequence: number; role: AgentRole }): CognitionNode {
  return {
    id: opts.id ?? `node-${opts.sequence}`,
    cognitionId: "cog-1",
    executionId: "exec-1",
    phase: "EXECUTE",
    status: opts.status ?? "COMPLETED",
    inputFingerprint: opts.inputFingerprint ?? `fp-${opts.sequence}`,
    input: opts.input ?? {},
    output: opts.output ?? {},
    memoryInfluence: opts.memoryInfluence ?? [],
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    ...opts
  } as CognitionNode;
}

function makeGraph(nodes: CognitionNode[]): CognitionGraph {
  return {
    id: "cog-1",
    executionId: "exec-1",
    agentId: "agent-1",
    phase: "COMPLETE",
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    nodes,
    handoffs: []
  };
}

interface HarnessOptions {
  graph?: CognitionGraph;
  signals?: FailureSignal[];
  frames?: ReplayFrame[];
  branches?: unknown[];
  getByExecution?: () => Promise<CognitionGraph | undefined>;
  analyzeExecution?: (executionId: string) => Promise<unknown>;
  materializeFrames?: () => Promise<ReplayFrame[]>;
  listByCognition?: () => Promise<FailureSignal[]>;
  listForCognition?: () => Promise<unknown[]>;
  /** Override the tenant guard to exercise the ownership-check path. */
  tenantGuard?: Pick<TenantGuard, "assertOwnsExecution">;
}

// buildReport only reads its arguments — the constructor deps are never touched
// (it just stores them + instantiates pure analyzers), so stub them.
const reportEngine = new FailureIntelligenceEngine(
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never
);

function buildContainer(opts: HarnessOptions): RuntimeContainer {
  const graph = opts.graph;
  const signals = opts.signals ?? [];
  const frames = opts.frames ?? [];
  const branches = opts.branches ?? [];

  const container = {
    tenantGuard: opts.tenantGuard ?? createPermissiveTenantGuard(),
    clock: { now: () => new Date(NOW_ISO) },
    cognitions: {
      getByExecution: opts.getByExecution ?? (async () => graph),
      getById: async () => graph
    },
    failureEngine: {
      analyzeExecution:
        opts.analyzeExecution ??
        (async (executionId: string) => reportEngine.buildReport(executionId, graph?.id, signals)),
      buildReport: reportEngine.buildReport.bind(reportEngine)
    },
    replayEngine: {
      materializeFrames: opts.materializeFrames ?? (async () => frames)
    },
    failureSignals: {
      listByCognition: opts.listByCognition ?? (async () => signals)
    },
    eventStore: {
      listByExecution: async () => []
    },
    branches: {
      listForCognition: opts.listForCognition ?? (async () => branches)
    }
  };
  return container as unknown as RuntimeContainer;
}

async function buildApp(container: RuntimeContainer): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Mirror auth-disabled mode: a synthetic admin tenant is attached to every
  // request so requireTenant() passes and the ownership guard is bypassed —
  // the same posture the dashboard runs under in dev.
  app.addHook("onRequest", async (request) => {
    request.tenant = ADMIN_TENANT;
  });
  // Mirror the production global catch-all (routes.ts setErrorHandler): the
  // tenant-isolation breaches map to 403 (never softened), and ANY other unmapped
  // throw that escapes a handler becomes a 500. If the route ever lets a stage
  // throw escape again, these tests will see a 500 and fail.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CrossTenantAccessError || error instanceof ResourceTenantNotResolvableError) {
      return reply.status(403).send({ error: "FORBIDDEN", message: "Cross-tenant access denied" });
    }
    return reply.status(500).send({ error: "INTERNAL_ERROR", message: "Unexpected runtime error" });
  });
  await registerSprintNextRoutes(app, container);
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function inject(method: "GET" | "POST", container: RuntimeContainer) {
  app = await buildApp(container);
  return app.inject({ method, url: "/executions/exec-1/full-analysis" });
}

describe("full-analysis route — returns 200, never 500", () => {
  it("empty execution (no cognition graph): 200, well-formed, not degraded", async () => {
    const res = await inject("GET", buildContainer({ graph: undefined }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.executionId).toBe("exec-1");
    expect(body.report.healthScore).toBe(100);
    expect(body.timeline).toBeNull();
    expect(body.topCausality).toBeNull();
    expect(body.branchCount).toBe(0);
    expect(body.degraded).toBe(false);
    expect(body.errors).toEqual([]);
  });

  it("POST verb still works (legacy cognition-api.ts client)", async () => {
    const res = await inject("POST", buildContainer({ graph: undefined }));
    expect(res.statusCode).toBe(200);
  });

  it("healthy execution: 200 with a built timeline and traced causality", async () => {
    const root = makeNode({ sequence: 0, role: "PLANNER", id: "root" });
    const child = makeNode({ sequence: 1, role: "EXECUTOR", id: "child", parentNodeId: "root" });
    const signal = makeSignal({ nodeId: "child", severity: "HIGH", evidence: [{ eventSequence: 1 }] });
    const res = await inject(
      "GET",
      buildContainer({
        graph: makeGraph([root, child]),
        signals: [signal],
        frames: [makeFrame(0), makeFrame(1)]
      })
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.report.totalSignals).toBe(1);
    expect(body.timeline).not.toBeNull();
    expect(body.timeline.frames).toHaveLength(2);
    expect(body.topCausality).not.toBeNull();
    expect(body.topCausality.links.length).toBeGreaterThan(0);
    expect(body.suggestBranch).toBe(true); // HIGH severity present
    expect(body.degraded).toBe(false);
  });

  // ── The original crash shapes — now 200 instead of 500 ───────────────────────

  it("signal with missing evidence array + node missing inputFingerprint: 200", async () => {
    // OLD behavior: builder iterated `signal.evidence` (undefined → not iterable)
    // and the tracer sliced `node.inputFingerprint` (undefined → TypeError).
    const node = makeNode({
      sequence: 0,
      role: "EXECUTOR",
      id: "n0",
      inputFingerprint: undefined as unknown as string
    });
    const badSignal = makeSignal({
      kind: "RECURSION",
      nodeId: "n0",
      score: NaN,
      severity: undefined as unknown as FailureSeverity,
      evidence: undefined as unknown as FailureSignal["evidence"]
    });
    const res = await inject(
      "GET",
      buildContainer({
        graph: makeGraph([node]),
        signals: [badSignal],
        frames: [makeFrame(0, { preview: undefined as unknown as ReplayFrame["preview"] })]
      })
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Real builders ran over malformed data and produced serializable output.
    expect(body.timeline).not.toBeNull();
    expect(body.topCausality).not.toBeNull();
    expect(Number.isFinite(body.report.healthScore)).toBe(true);
  });

  // ── Per-stage failure isolation: each stage degrades, route stays 200 ────────

  it("report stage throws: 200, degraded, fallback report, error recorded", async () => {
    const res = await inject(
      "GET",
      buildContainer({
        graph: makeGraph([makeNode({ sequence: 0, role: "PLANNER" })]),
        analyzeExecution: async () => {
          throw new Error("analyzer engine exploded");
        }
      })
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.degraded).toBe(true);
    expect(body.errors.map((e: { stage: string }) => e.stage)).toContain("report");
    expect(body.report.healthScore).toBe(100); // well-formed fallback
  });

  it("frames + signals stores both throw: 200, both stages recorded as degraded", async () => {
    const res = await inject(
      "GET",
      buildContainer({
        graph: makeGraph([makeNode({ sequence: 0, role: "PLANNER" })]),
        materializeFrames: async () => {
          throw new Error("frame store read failed");
        },
        listByCognition: async () => {
          throw new Error("signal store read failed");
        }
      })
    );
    expect(res.statusCode).toBe(200);
    const stages = res.json().errors.map((e: { stage: string }) => e.stage);
    expect(stages).toContain("frames");
    expect(stages).toContain("signals");
  });

  it("graph lookup throws: 200, degraded, report still returned via fallback", async () => {
    const res = await inject(
      "GET",
      buildContainer({
        getByExecution: async () => {
          throw new Error("cognition store unavailable");
        }
      })
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.degraded).toBe(true);
    expect(body.errors.map((e: { stage: string }) => e.stage)).toContain("graph-lookup");
  });

  it("non-serializable value in the payload (BigInt) degrades, never 500s", async () => {
    // A BigInt that leaked into a signal's evidence (e.g. from a raw tool result)
    // would make Fastify's JSON.stringify throw at serialization time — AFTER the
    // handler returned, bypassing every per-stage guard. The serialize stage
    // catches it and returns a well-formed, stripped envelope instead of a 500.
    const poison = makeSignal({
      nodeId: "child",
      severity: "HIGH",
      evidence: [{ eventSequence: 1, metric: { leaked: 10n as unknown as number } }]
    });
    const root = makeNode({ sequence: 0, role: "PLANNER", id: "root" });
    const child = makeNode({ sequence: 1, role: "EXECUTOR", id: "child", parentNodeId: "root" });
    const res = await inject(
      "GET",
      buildContainer({
        graph: makeGraph([root, child]),
        signals: [poison],
        frames: [makeFrame(0), makeFrame(1)]
      })
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.degraded).toBe(true);
    expect(body.errors.map((e: { stage: string }) => e.stage)).toContain("serialize");
    // Heavy analytic payloads dropped; envelope still well-formed and renderable.
    expect(body.timeline).toBeNull();
    expect(body.topCausality).toBeNull();
    expect(body.report.healthScore).toBe(100);
  });

  // ── Ownership check: the one stage that runs BEFORE the per-stage guards ─────

  it("ownership resolution hits an unexpected infra error: 200, degraded, no 500", async () => {
    // A developer-role dashboard does not bypass the guard, so assertOwnsExecution
    // runs a real DB query. A missing tenant_id column (out-of-sync migration) or
    // a dropped connection used to escape every guard → opaque INTERNAL_ERROR 500.
    const res = await inject(
      "GET",
      buildContainer({
        graph: makeGraph([makeNode({ sequence: 0, role: "PLANNER" })]),
        signals: [makeSignal()],
        frames: [makeFrame(0)],
        tenantGuard: {
          assertOwnsExecution: async () => {
            const err = new Error('column "tenant_id" does not exist') as Error & { code: string };
            err.code = "42703";
            throw err;
          }
        }
      })
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.degraded).toBe(true);
    expect(body.errors.map((e: { stage: string }) => e.stage)).toContain("ownership-check");
    // Fail closed: no tenant data resolved, well-formed empty envelope.
    expect(body.report.healthScore).toBe(100);
    expect(body.report.totalSignals).toBe(0);
    expect(body.timeline).toBeNull();
    expect(body.topCausality).toBeNull();
  });

  it("cross-tenant access is NEVER softened to 200 — propagates as 403", async () => {
    const res = await inject(
      "GET",
      buildContainer({
        graph: makeGraph([makeNode({ sequence: 0, role: "PLANNER" })]),
        tenantGuard: {
          assertOwnsExecution: async () => {
            throw new CrossTenantAccessError("execution");
          }
        }
      })
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("unresolvable tenant is NEVER softened to 200 — propagates as 403", async () => {
    const res = await inject(
      "GET",
      buildContainer({
        tenantGuard: {
          assertOwnsExecution: async () => {
            throw new ResourceTenantNotResolvableError("execution", "exec-1");
          }
        }
      })
    );
    expect(res.statusCode).toBe(403);
  });

  it("branch analysis throws: 200, degraded, branchCount falls back to 0", async () => {
    const res = await inject(
      "GET",
      buildContainer({
        graph: makeGraph([makeNode({ sequence: 0, role: "PLANNER" })]),
        listForCognition: async () => {
          throw new Error("branch registry unavailable");
        }
      })
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.branchCount).toBe(0);
    expect(body.errors.map((e: { stage: string }) => e.stage)).toContain("branch-analysis");
  });
});
