import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContainer } from "../../application/runtimeContainer.js";
import { NotFoundError } from "../../shared/errors.js";
import { createId } from "../../shared/id.js";
import { FailureTimelineBuilder } from "../../runtime/replay/failureTimeline.js";
import { CausalityTracer } from "../../runtime/replay/causalityTracer.js";
import {
  calculateConfidenceScore,
  makeOrchestrationDecision
} from "../../runtime/confidence/confidencePolicyEngine.js";
import { requireRole } from "../../infrastructure/security/rbac.js";
import { requireTenant } from "../../infrastructure/security/tenantContext.js";
import type { TenantGuard } from "../../infrastructure/security/tenantGuard.js";

const checkpointSchema = z.object({
  frameIndex: z.number().int().nonnegative(),
  name: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
  sessionId: z.string().optional()
});

const startCognitionSchema = z.object({
  agentId: z.string().min(1),
  goal: z.string().min(1),
  task: z.record(z.unknown()).default({}),
  parentCognitionId: z.string().optional(),
  parentNodeId: z.string().optional(),
  seed: z.string().optional()
});

const branchSchema = z.object({
  sourceCognitionId: z.string().min(1),
  sourceNodeId: z.string().min(1),
  reason: z.string().optional(),
  overrides: z
    .object({
      input: z.record(z.unknown()).optional(),
      seed: z.string().optional(),
      model: z.string().optional()
    })
    .optional()
});

const seekSchema = z.object({ frameIndex: z.number().int().nonnegative() });
const playSchema = z.object({ speed: z.number().min(0).max(8) });
const snapshotSchema = z.object({ frameIndex: z.number().int().nonnegative() });

/**
 * Sprint Next HTTP routes: cognition, replay, time-travel, failure intel.
 * Mounted alongside the existing /agents and /cluster routes.
 *
 * Multi-tenant security hardening:
 *   Every per-resource route validates tenant ownership of the underlying
 *   cognition / replay session / branch / failure signal. Without these
 *   guards, an enumerated cognition ID would have exposed another tenant's
 *   reasoning trace (a high-impact IDOR — cognition payloads include the
 *   original prompt, model outputs, and downstream side effects).
 *
 *   Writes (start cognition, create replay session, branch replay, named
 *   checkpoint creation, full-analysis runs) additionally require role
 *   developer+ to prevent privilege escalation through unrestricted endpoints.
 */
export async function registerSprintNextRoutes(app: FastifyInstance, container: RuntimeContainer): Promise<void> {
  // Tenant guard (Postgres-backed when DATABASE_URL is set, permissive fallback
  // in the in-memory/test mode). Used by every per-resource handler below.
  const guard: TenantGuard = app.hasDecorator("tenantGuard")
    ? app.tenantGuard
    : container.tenantGuard;
  const devRole = requireRole("developer");

  // --- Cognition ---
  app.post("/cognition", { preHandler: devRole }, async (request, reply) => {
    const ctx = requireTenant(request);
    const body = startCognitionSchema.parse(request.body);
    // The cognition is rooted on an agent; the agent must belong to this tenant.
    await guard.assertOwnsAgent(ctx, body.agentId);
    // If a parentCognitionId is supplied (sub-cognition spawn), the caller must
    // also own it — otherwise they could graft their cognition into another
    // tenant's lineage and leak carry-over context downstream.
    if (body.parentCognitionId) {
      await guard.assertOwnsCognition(ctx, body.parentCognitionId);
    }
    const graph = await container.cognitionCommands.startCognition(body, {
      traceId: createId(),
      correlationId: request.id,
      tenantId: ctx.tenantId
    } as { traceId: string; correlationId: string; tenantId?: string });
    return reply.status(201).send(graph);
  });

  app.get("/cognition", async (request) => {
    const ctx = requireTenant(request);
    const limit = Number((request.query as Record<string, string | undefined>).limit ?? 25);
    const all = await container.cognitionQueries.listRecent(Math.min(100, Math.max(1, limit)));
    if (ctx.role === "admin") return all;
    // Filter to the caller's tenant. The cognition_graphs table doesn't yet
    // carry tenant_id, so resolve via the related execution.
    const owned: typeof all = [];
    for (const g of all) {
      const t = await guard.resolveCognitionTenant(g.id);
      if (t === null || t === ctx.tenantId) owned.push(g);
    }
    return owned;
  });

  app.get("/cognition/:cognitionId", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const view = await container.cognitionQueries.get(cognitionId);
    if (!view) throw new NotFoundError("Cognition", cognitionId);
    return view;
  });

  app.get("/cognition/:cognitionId/lineage", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const view = await container.cognitionQueries.get(cognitionId);
    if (!view) throw new NotFoundError("Cognition", cognitionId);
    return view.lineage;
  });

  app.get("/cognition/:cognitionId/memory-influence", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const heatmap = await container.memoryInfluence.heatmap(cognitionId);
    if (!heatmap) throw new NotFoundError("Cognition", cognitionId);
    return heatmap;
  });

  app.get("/cognition/:cognitionId/memory-trust", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const graph = await container.cognitions.getById(cognitionId);
    if (!graph) throw new NotFoundError("Cognition", cognitionId);

    const events = await container.eventStore.listByExecution(graph.executionId);
    const trustEvent = events
      .filter((e) => (e.type as string) === "MEMORY_TRUST_EVALUATED")
      .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0];

    if (trustEvent && trustEvent.payload) {
      return trustEvent.payload;
    }

    // Dynamic compilation fallback
    const memories = await container.memory.listByAgent(graph.agentId);
    const executionStatusMap = new Map<string, "COMPLETED" | "FAILED" | "RUNNING" >();
    await Promise.all(
      memories
        .filter((m) => m.executionId)
        .map(async (m) => {
          const exec = await container.executions.getById(m.executionId!);
          if (exec) {
            executionStatusMap.set(
              m.executionId!,
              exec.status === "COMPLETED" ? "COMPLETED" : exec.status === "FAILED" ? "FAILED" : "RUNNING"
            );
          }
        })
    );

    const scoredMemories = container.memoryTrustEngine.scoreAndFilter(
      memories,
      (graph.nodes[0]?.input?.goal as string) || "",
      { executionStatusMap }
    );

    return {
      cognitionId,
      scoredMemories
    };
  });

  app.get("/cognition/:cognitionId/nodes", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const query = request.query as { offset?: string; limit?: string };
    const offset = Number(query.offset ?? 0);
    const limit = Number(query.limit ?? 50);

    const graph = await container.cognitions.getById(cognitionId);
    if (!graph) throw new NotFoundError("Cognition", cognitionId);

    const nodes = graph.nodes
      .sort((a, b) => a.sequence - b.sequence)
      .slice(offset, offset + limit);

    return nodes;
  });

  app.get("/cognition/:cognitionId/nodes/:nodeId", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId, nodeId } = request.params as { cognitionId: string; nodeId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const graph = await container.cognitions.getById(cognitionId);
    if (!graph) throw new NotFoundError("Cognition", cognitionId);

    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new NotFoundError("CognitionNode", nodeId);

    return node;
  });

  // --- Replay ---
  app.get("/cognition/:cognitionId/replay/frames", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    return container.replayQueries.listFrames(cognitionId);
  });

  // Creating a replay session is a write — it materialises frames and may
  // execute model providers. Restrict to developer+ and assert ownership.
  app.post("/cognition/:cognitionId/replay", { preHandler: devRole }, async (request, reply) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const session = await container.cognitionCommands.createReplaySession(cognitionId);
    return reply.status(201).send(session);
  });

  app.get("/replay/:sessionId", async (request) => {
    const ctx = requireTenant(request);
    const { sessionId } = request.params as { sessionId: string };
    await guard.assertOwnsReplaySession(ctx, sessionId);
    const view = await container.replayQueries.getSession(sessionId);
    if (!view) throw new NotFoundError("ReplaySession", sessionId);
    return view;
  });

  app.post("/replay/:sessionId/seek", { preHandler: devRole }, async (request) => {
    const ctx = requireTenant(request);
    const { sessionId } = request.params as { sessionId: string };
    await guard.assertOwnsReplaySession(ctx, sessionId);
    const body = seekSchema.parse(request.body);
    return container.cognitionCommands.seekReplay(sessionId, body.frameIndex);
  });

  app.post("/replay/:sessionId/play", { preHandler: devRole }, async (request) => {
    const ctx = requireTenant(request);
    const { sessionId } = request.params as { sessionId: string };
    await guard.assertOwnsReplaySession(ctx, sessionId);
    const body = playSchema.parse(request.body);
    return container.cognitionCommands.playReplay(sessionId, body.speed);
  });

  app.post("/replay/:sessionId/snapshot", { preHandler: devRole }, async (request) => {
    const ctx = requireTenant(request);
    const { sessionId } = request.params as { sessionId: string };
    await guard.assertOwnsReplaySession(ctx, sessionId);
    const body = snapshotSchema.parse(request.body);
    const session = await container.replaySessions.get(sessionId);
    if (!session) throw new NotFoundError("ReplaySession", sessionId);
    return container.cognitionCommands.snapshotAtFrame(session.cognitionId, body.frameIndex);
  });

  // Branch replay is the highest-risk operation in the system: it reconstructs
  // an execution from a checkpoint and re-runs model providers. Cross-tenant
  // branching would let an attacker fork another tenant's reasoning trace and
  // inject inputs into the resumed flow — a runtime ownership bypass.
  app.post("/replay/branch", { preHandler: devRole }, async (request, reply) => {
    const ctx = requireTenant(request);
    const body = branchSchema.parse(request.body);
    await guard.assertOwnsCognition(ctx, body.sourceCognitionId);
    const pointer = await container.cognitionCommands.branchFromNode(body);
    return reply.status(201).send(pointer);
  });

  app.get("/replay/branches", async (request) => {
    const ctx = requireTenant(request);
    const all = await container.branches.listAll();
    if (ctx.role === "admin") return all;
    const owned: typeof all = [];
    for (const b of all) {
      // BranchPointer is keyed on the source cognition rather than a dedicated
      // branch id, so resolve tenancy via that.
      const t = await guard.resolveCognitionTenant(b.sourceCognitionId);
      if (t === null || t === ctx.tenantId) owned.push(b);
    }
    return owned;
  });

  app.get("/replay/diff", async (request) => {
    const ctx = requireTenant(request);
    const { source, branch } = request.query as { source?: string; branch?: string };
    if (!source || !branch) {
      throw new NotFoundError("ReplayDiff", "source+branch required");
    }
    // Both endpoints of the diff must be owned by the caller. A subtle but
    // important guard: without it, a developer could diff their own cognition
    // against another tenant's cognition and exfiltrate the difference.
    await guard.assertOwnsCognition(ctx, source);
    await guard.assertOwnsCognition(ctx, branch);
    return container.replayEngine.diffCognitions(source, branch);
  });

  // --- Failure intelligence ---
  app.get("/cognition/:cognitionId/failure-report", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const view = await container.cognitionQueries.get(cognitionId);
    if (!view) throw new NotFoundError("Cognition", cognitionId);
    return container.failureEngine.buildReport(view.graph.executionId, cognitionId, view.failureSignals);
  });

  app.post("/executions/:executionId/analyze-failures", { preHandler: devRole }, async (request) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    await guard.assertOwnsExecution(ctx, executionId);
    return container.failureEngine.analyzeExecution(executionId);
  });

  app.get("/failure-signals/recent", async (request) => {
    const ctx = requireTenant(request);
    const limit = Number((request.query as Record<string, string | undefined>).limit ?? 50);
    const all = await container.failureSignals.listRecent(Math.min(200, Math.max(1, limit)));
    if (ctx.role === "admin") return all;
    const owned: typeof all = [];
    for (const s of all) {
      const t = await guard.resolveFailureSignalTenant(s.id);
      if (t === null || t === ctx.tenantId) owned.push(s);
    }
    return owned;
  });

  // ── Phase 3: Failure Timeline ──────────────────────────────────────────────
  // Maps every failure signal onto the replay frame timeline so operators can
  // scrub to the exact moment of failure and see causal role annotations.
  app.get("/cognition/:cognitionId/failure-timeline", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const graph = await container.cognitions.getById(cognitionId);
    if (!graph) throw new NotFoundError("Cognition", cognitionId);

    const [frames, signals] = await Promise.all([
      container.replayEngine.materializeFrames(graph),
      container.failureSignals.listByCognition(cognitionId)
    ]);

    const builder = new FailureTimelineBuilder();
    return builder.build(frames, signals, graph);
  });

  // ── Phase 3: Causality Tracing ─────────────────────────────────────────────
  // Given a failure signal ID, traces backward through the execution graph
  // to identify the root cause chain and maps it to replay frame indices.
  app.get("/failure-signals/:signalId/causality", async (request) => {
    const ctx = requireTenant(request);
    const { signalId } = request.params as { signalId: string };
    await guard.assertOwnsFailureSignal(ctx, signalId);
    const recent = await container.failureSignals.listRecent(500);
    const signal = recent.find((s) => s.id === signalId);
    if (!signal) throw new NotFoundError("FailureSignal", signalId);

    const graph = signal.cognitionId
      ? await container.cognitions.getById(signal.cognitionId)
      : await container.cognitions.getByExecution(signal.executionId);

    const frames = graph ? await container.replayEngine.materializeFrames(graph) : [];

    const tracer = new CausalityTracer(
      container.cognitions,
      container.eventStore,
      container.clock
    );
    return tracer.trace(signal, frames);
  });

  // ── Phase 3: Named Replay Checkpoints ──────────────────────────────────────
  // Operator-placed named markers in a replay session for branching and comparison.
  app.post("/cognition/:cognitionId/checkpoints", { preHandler: devRole }, async (request, reply) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const body = checkpointSchema.parse(request.body);
    if (body.sessionId) {
      await guard.assertOwnsReplaySession(ctx, body.sessionId);
    }
    const checkpoint = await container.checkpointManager.createCheckpoint(
      cognitionId,
      body.frameIndex,
      body.name,
      body.note,
      body.sessionId
    );
    return reply.status(201).send(checkpoint);
  });

  app.get("/cognition/:cognitionId/checkpoints", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    return container.checkpointManager.listCheckpoints(cognitionId);
  });

  // ── Phase 3: Deep Cognition Diff ───────────────────────────────────────────
  // Structural diff between two cognitions explaining WHY they diverged:
  // first divergent node, changed outputs, handoff path changes, interpretation.
  app.get("/replay/cognition-diff", async (request) => {
    const ctx = requireTenant(request);
    const { source, branch } = request.query as { source?: string; branch?: string };
    if (!source || !branch) throw new NotFoundError("CognitionDiff", "source+branch required");
    await guard.assertOwnsCognition(ctx, source);
    await guard.assertOwnsCognition(ctx, branch);
    return container.checkpointManager.diffCognitions(source, branch);
  });

  // ── Phase 3: Branch Comparison ─────────────────────────────────────────────
  // Aggregate comparison across all branches of a source cognition.
  // Returns ranked branches by health score with a recommended winner.
  app.get("/cognition/:cognitionId/branch-comparison", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const graph = await container.cognitions.getById(cognitionId);
    if (!graph) throw new NotFoundError("Cognition", cognitionId);
    return container.checkpointManager.compareBranches(cognitionId);
  });

  // ── Phase 3: Confidence Trace ──────────────────────────────────────────────
  // Returns per-node confidence data as a time series so the UI can render
  // the confidence degradation curve for an execution.
  app.get("/cognition/:cognitionId/confidence-trace", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const graph = await container.cognitions.getById(cognitionId);
    if (!graph) throw new NotFoundError("Cognition", cognitionId);

    const nodes = graph.nodes
      .filter((n) => n.status === "COMPLETED" && n.uncertainty)
      .sort((a, b) => a.sequence - b.sequence)
      .map((n) => ({
        nodeId: n.id,
        sequence: n.sequence,
        role: n.role,
        uncertaintyOverall: n.uncertainty!.overall,
        uncertaintyVariance: n.uncertainty!.variance,
        lowConfidenceTokens: n.uncertainty!.lowConfidenceTokens,
        selfReport: n.uncertainty!.selfReport,
        durationMs: n.durationMs
      }));

    const avg = nodes.length > 0
      ? nodes.reduce((a, n) => a + n.uncertaintyOverall, 0) / nodes.length
      : 0;
    const peak = nodes.length > 0
      ? nodes.reduce((a, n) => Math.max(a, n.uncertaintyOverall), 0)
      : 0;
    const peakNode = nodes.find((n) => n.uncertaintyOverall === peak);

    return {
      cognitionId,
      nodeCount: nodes.length,
      averageUncertainty: Number(avg.toFixed(3)),
      peakUncertainty: Number(peak.toFixed(3)),
      peakAtNodeId: peakNode?.nodeId,
      trace: nodes
    };
  });

  // ── Confidence Dashboard Integration ──────────────────────────────────────
  // Exposes real-time transitions, policy decisions, stabilization actions,
  // and the degradation timeline for visualization on the operator replay panel.
  app.get("/cognition/:cognitionId/confidence-dashboard", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const graph = await container.cognitions.getById(cognitionId);
    if (!graph) throw new NotFoundError("Cognition", cognitionId);

    const completedNodes = graph.nodes
      .filter((n) => n.status === "COMPLETED")
      .sort((a, b) => a.sequence - b.sequence);

    // Calculate current stats
    const currentScore = completedNodes.length > 0
      ? calculateConfidenceScore(completedNodes[completedNodes.length - 1])
      : 100;
    const currentClassification = completedNodes.length > 0
      ? completedNodes[completedNodes.length - 1].confidenceClassification ?? "HIGH"
      : "HIGH";

    const transitions: Array<{
      nodeId: string;
      sequence: number;
      role: string;
      from?: string;
      to: string;
      confidenceScore: number;
    }> = [];

    const decisions: Array<{
      nodeId: string;
      sequence: number;
      role: string;
      confidenceScore: number;
      classification: string;
      decision: ReturnType<typeof makeOrchestrationDecision>;
    }> = [];

    const timeline: Array<{
      timestamp: string;
      type: "DEGRADED" | "RECOVERED" | "CRITICAL" | "STABLE";
      nodeId: string;
      role: string;
      confidenceScore: number;
      details: string;
    }> = [];

    for (let i = 0; i < completedNodes.length; i++) {
      const node = completedNodes[i];
      const score = calculateConfidenceScore(node);
      const dec = makeOrchestrationDecision(score);
      const prevNode = completedNodes[i - 1];
      const prevScore = prevNode ? calculateConfidenceScore(prevNode) : undefined;
      const prevClass = prevNode ? prevNode.confidenceClassification : undefined;

      // Transitions
      if (node.confidenceClassification && prevClass !== node.confidenceClassification) {
        transitions.push({
          nodeId: node.id,
          sequence: node.sequence,
          role: node.role,
          from: prevClass,
          to: node.confidenceClassification,
          confidenceScore: score
        });
      }

      // Decisions
      decisions.push({
        nodeId: node.id,
        sequence: node.sequence,
        role: node.role,
        confidenceScore: score,
        classification: node.confidenceClassification ?? "HIGH",
        decision: dec
      });

      // Timeline entries
      if (score < 30) {
        timeline.push({
          timestamp: node.completedAt ?? new Date().toISOString(),
          type: "CRITICAL",
          nodeId: node.id,
          role: node.role,
          confidenceScore: score,
          details: `Confidence score entered critical zone: ${score.toFixed(2)}. ${node.instabilityAttribution?.reason ?? ""}`
        });
      } else if (node.degradationTracking && node.degradationTracking.confidenceDrop > 10) {
        timeline.push({
          timestamp: node.completedAt ?? new Date().toISOString(),
          type: "DEGRADED",
          nodeId: node.id,
          role: node.role,
          confidenceScore: score,
          details: `Confidence degraded by ${node.degradationTracking.confidenceDrop.toFixed(2)} points from parent.`
        });
      }

      if (score >= 50 && prevScore !== undefined && prevScore < 50) {
        timeline.push({
          timestamp: node.completedAt ?? new Date().toISOString(),
          type: "RECOVERED",
          nodeId: node.id,
          role: node.role,
          confidenceScore: score,
          details: `Confidence recovered to stable zone: ${score.toFixed(2)} (+${(score - prevScore).toFixed(2)} points).`
        });
      }
    }

    return {
      cognitionId,
      executionId: graph.executionId,
      agentId: graph.agentId,
      currentConfidenceScore: Number(currentScore.toFixed(2)),
      currentClassification,
      autonomyLevel: graph.autonomyLevel ?? "FULL",
      escalationRequired: graph.escalationRequired ?? false,
      transitions,
      decisions,
      stabilizationActions: graph.stabilizationActionsTaken ?? [],
      timeline
    };
  });

  app.get("/cognition/:cognitionId/planner-consensus", async (request) => {
    const ctx = requireTenant(request);
    const { cognitionId } = request.params as { cognitionId: string };
    await guard.assertOwnsCognition(ctx, cognitionId);
    const graph = await container.cognitions.getById(cognitionId);
    if (!graph) throw new NotFoundError("Cognition", cognitionId);

    const planningNodes = graph.nodes
      .filter((n) => n.role === "PLANNER" && n.status === "COMPLETED")
      .sort((a, b) => a.sequence - b.sequence);
    const latestPlanningNode = planningNodes[planningNodes.length - 1];

    if (!latestPlanningNode) {
      return {
        cognitionId,
        hasConsensus: false,
        message: "No completed planning node found for this cognition."
      };
    }

    const ensemble = latestPlanningNode.output?.__ensemble as any;
    if (!ensemble) {
      return {
        cognitionId,
        hasConsensus: false,
        message: "Planning node found, but no ensemble metadata was stored."
      };
    }

    const { __ensemble, __role, ...cleanPlan } = latestPlanningNode.output || {};

    return {
      cognitionId,
      hasConsensus: true,
      plannerAgreement: ensemble.plannerAgreement,
      consensusConfidence: ensemble.consensusConfidence,
      unstable: ensemble.unstable,
      recursiveDecomposition: ensemble.recursiveDecomposition,
      rejectedPlans: ensemble.rejectedPlans,
      arbitrationOutcome: ensemble.arbitrationOutcome,
      divergenceMap: ensemble.divergenceMap,
      visualDiff: ensemble.visualDiff,
      chosenPlan: cleanPlan
    };
  });

  // ── Phase 3: Demo flow endpoint ────────────────────────────────────────────
  // Single endpoint that runs the complete demo scenario:
  // analyze → detect failure → produce timeline + causality for the top signal.
  // Designed for the operator dashboard "run analysis" action.
  app.post("/executions/:executionId/full-analysis", { preHandler: devRole }, async (request) => {
    const ctx = requireTenant(request);
    const { executionId } = request.params as { executionId: string };
    await guard.assertOwnsExecution(ctx, executionId);

    // 1. Run all analyzers.
    const report = await container.failureEngine.analyzeExecution(executionId);

    // 2. If there are signals, build the failure timeline.
    const graph = await container.cognitions.getByExecution(executionId);
    let timeline = null;
    let topCausality = null;

    if (graph) {
      const [frames, allSignals] = await Promise.all([
        container.replayEngine.materializeFrames(graph),
        container.failureSignals.listByCognition(graph.id)
      ]);

      if (allSignals.length > 0) {
        const builder = new FailureTimelineBuilder();
        timeline = builder.build(frames, allSignals, graph);

        // 3. Trace causality for the top signal (highest score).
        const topSignal = allSignals.sort((a, b) => b.score - a.score)[0];
        const tracer = new CausalityTracer(
          container.cognitions,
          container.eventStore,
          container.clock
        );
        topCausality = await tracer.trace(topSignal, frames);
      }
    }

    // 4. Fetch any existing branches for comparison.
    const branches = graph
      ? await container.branches.listForCognition(graph.id)
      : [];

    return {
      executionId,
      cognitionId: graph?.id,
      report,
      timeline,
      topCausality,
      branchCount: branches.length,
      // Hint for the UI: if there are HIGH/CRITICAL signals, suggest branching.
      suggestBranch: report.bySeverity.HIGH > 0 || report.bySeverity.CRITICAL > 0,
      branchSuggestion: (report.bySeverity.HIGH > 0 || report.bySeverity.CRITICAL > 0)
        ? "Branch replay at the ROOT_CAUSE frame to test corrective inputs"
        : null
    };
  });
}
