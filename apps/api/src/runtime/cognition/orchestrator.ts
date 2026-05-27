import type {
  AgentRole,
  CognitionGraph,
  CognitionNode,
  CognitionPhase,
  CognitionStartInput
} from "../../domain/cognition.js";
import type {
  BranchRegistry,
  CognitionRepository,
  LineageStore
} from "../../domain/cognitionPorts.js";
import type { EventFactory, EventContext } from "../../infrastructure/events/eventFactory.js";
import type { PersistedEventPublisher } from "../../infrastructure/events/persistedEventPublisher.js";
import type { Clock } from "../../shared/clock.js";
import type { MemoryRepository, ExecutionRepository, AgentRepository } from "../../domain/ports.js";
import { MemoryTrustEngine, type ScoredMemory } from "../../memory/trust/memoryTrustEngine.js";
import type { RoleAgent, RoleContext, RoleResult } from "./roles.js";
import { toIso } from "../../shared/clock.js";
import { createId } from "../../shared/id.js";
import { deterministicId, fingerprint } from "../../shared/determinism.js";
import { CognitionStateMachine } from "./cognitionStateMachine.js";
import {
  calculateConfidenceScore,
  makeOrchestrationDecision,
  propagateConfidence
} from "../confidence/confidencePolicyEngine.js";
import {
  PlannerValidationError,
  LowConfidenceExecutionBlocked,
  RuntimeExecutionError,
  ToolContractViolation,
  NodeResolutionFailure
} from "../../shared/errors.js";

export interface CognitionOrchestratorDeps {
  cognitions: CognitionRepository;
  lineage: LineageStore;
  memory: MemoryRepository;
  publisher: PersistedEventPublisher;
  eventFactory: EventFactory;
  clock: Clock;
  roles: Record<AgentRole, RoleAgent>;
  branches?: BranchRegistry;
  memoryTrustEngine?: MemoryTrustEngine;
  executions?: ExecutionRepository;
  agents?: AgentRepository;
  /** Maximum verifier→executor retries per cognition. */
  retryBudget?: number;
}

/**
 * Cognition Orchestrator — drives a single CognitionGraph from INIT → COMPLETE.
 *
 * Each role invocation produces a deterministic CognitionNode whose ID is
 * hash(executionId, sequence, role, inputFingerprint). Replaying the same
 * event log produces identical IDs.
 */
export class CognitionOrchestrator {
  private readonly retryBudget: number;
  constructor(private readonly deps: CognitionOrchestratorDeps) {
    this.retryBudget = deps.retryBudget ?? 2;
  }

  async run(input: CognitionStartInput, context: EventContext): Promise<CognitionGraph> {
    // ─── Fresh-vs-deterministic cognitionId selection ──────────────────────
    //
    // The previous implementation derived cognitionId purely from
    // (agentId, fingerprint(task), parents). Re-running the same task on
    // the same agent therefore yielded the *same* cognitionId, which:
    //
    //   • caused `cognition_graphs` rows to be overwritten in-place via the
    //     postgres `on conflict (id) do update` path, leaving stale node /
    //     handoff rows from the prior run attached to the "new" cognition,
    //   • surfaced in the workbench as the prior cognition's graph never
    //     refreshing on click of "+ run",
    //   • produced 500s when concurrent runs hit conflict on cognition_handoffs.
    //
    // New rule:
    //   • Replays/branches go through ReplayEngine — they never reach this
    //     code path, so their deterministic IDs are untouched.
    //   • If the caller supplied `parentCognitionId` (sub-cognition spawn
    //     from a parent), keep the legacy deterministic derivation so the
    //     parent → child lineage hash remains stable for that pair.
    //   • If the caller supplied an explicit `input.seed`, mix the seed
    //     into the hash so test fixtures can opt in to deterministic IDs.
    //   • Otherwise (default — every new root prompt from the UI), inject
    //     a fresh `createId()` nonce so a re-run produces a brand-new id.
    const isRoot = !input.parentCognitionId && !input.parentNodeId;
    const nonce = input.seed
      ? `seed:${input.seed}`
      : isRoot
        ? `nonce:${createId()}`
        : "";
    const cognitionId = deterministicId([
      input.agentId,
      await fingerprint(input.task),
      input.parentCognitionId ?? "",
      input.parentNodeId ?? "",
      nonce
    ]);
    const executionId = deterministicId([cognitionId, "execution"]);

    // C-1: derive the tenant from (1) the explicit input tenant when callers
    // already resolved it (live HTTP routes), (2) the owning execution's
    // tenant (replay/branch path), (3) the request context, falling back to
    // 'system' when none are present so the cognition_graphs row carries a
    // non-empty tenant_id rather than tripping the postgres assertion.
    const resolvedTenantId =
      input.tenantId
        ?? (await this.lookupExecutionTenant(executionId))
        ?? contextTenantId(context)
        ?? "system";

    const graph: CognitionGraph = {
      id: cognitionId,
      executionId,
      agentId: input.agentId,
      parentCognitionId: input.parentCognitionId,
      parentNodeId: input.parentNodeId,
      tenantId: resolvedTenantId,
      phase: "INIT",
      startedAt: toIso(this.deps.clock.now()),
      nodes: [],
      handoffs: []
    };

    let carryOver: Record<string, unknown> = {};

    // Structured correlation log line. Emitted on the publisher event bus
    // so the same trace can be joined against the SSE stream (which is the
    // same bus) for end-to-end debugging. cognitionId + executionId +
    // correlationId + traceId are all stamped so a 500 reported by a
    // client can be grepped back to this exact orchestrator invocation.
    await this.deps.publisher.publish(
      this.deps.eventFactory.create({
        type: "COGNITION_TRACE" as any,
        aggregateId: executionId,
        aggregateType: "EXECUTION",
        payload: {
          phase: "start",
          cognitionId,
          executionId,
          agentId: input.agentId,
          isRoot,
          tenantId: resolvedTenantId
        },
        context
      })
    );

    try {
      await this.deps.cognitions.save(graph);
      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: "COGNITION_STARTED",
          aggregateId: executionId,
          aggregateType: "EXECUTION",
          payload: { graph },
          context
        })
      );

      let currentPhase: CognitionPhase = "PLAN";
      let sequence = 0;
      let retriesUsed = 0;
      const seed = input.seed ?? cognitionId;

      while (!CognitionStateMachine.isTerminal(currentPhase)) {
        const role = CognitionStateMachine.roleForPhase(currentPhase);
        if (!role) break;
        const agent = this.deps.roles[role];
        if (!agent) {
          await this.markFailed(graph, `No role agent registered for ${role}`, context);
          return this.snapshot(cognitionId);
        }

        sequence += 1;
        
        let node: CognitionNode;
        try {
          node = await this.runRole(graph, agent, currentPhase, carryOver, seed, sequence, context, input);
        } catch (roleError) {
          const typedErr = roleError instanceof Error ? roleError : new Error(String(roleError));
          throw new RuntimeExecutionError(
            `Execution failed at stage ${currentPhase}: ${typedErr.message}`,
            cognitionId,
            true,
            true,
            roleError
          );
        }

        // Lineage: chain each node to the prior.
        const prior = graph.nodes[graph.nodes.length - 2];
        if (prior) await this.deps.lineage.recordParent(node.id, prior.id);

        if (node.status === "FAILED") {
          const errMessage = typeof node.output?.error === "string" ? node.output.error : "Role agent failed";
          throw new RuntimeExecutionError(
            `Execution failed at stage ${currentPhase}: ${errMessage}`,
            cognitionId,
            true,
            true,
            new Error(errMessage)
          );
        }

        const result = (node.output ?? {}) as { __role?: RoleResult };
        const roleResult = result.__role!;
        carryOver = { ...carryOver, ...roleResult.output };

        // IMPLEMENT SAFE PLANNER OUTPUT VALIDATION
        if (currentPhase === "PLAN") {
          await this.validatePlannerOutput(node, graph.agentId);
        }

        // Apply confidence-aware orchestration decisions if completed
        if (node.status === "COMPLETED" && node.confidenceScore !== undefined) {
          const score = node.confidenceScore;
          
          // IMPLEMENT LOW-CONFIDENCE SAFETY GATING FOR PLANNER OUTPUT
          if (currentPhase === "PLAN" && score < 50) {
            if (score >= 40) {
              // 1. Degraded execution mode
              graph.autonomyLevel = "DEGRADED";
              if (!graph.stabilizationActionsTaken) graph.stabilizationActionsTaken = [];
              const actionText = `DEGRADED_EXECUTION: Planner confidence low (${score.toFixed(2)}). Lowering autonomy to DEGRADED.`;
              graph.stabilizationActionsTaken.push(actionText);
              await this.deps.cognitions.save(graph);

              await this.deps.publisher.publish(
                this.deps.eventFactory.create({
                  type: "COGNITION_ORCHESTRATION_DECISION",
                  aggregateId: executionId,
                  aggregateType: "EXECUTION",
                  payload: { cognitionId, decision: "DEGRADED", score, details: actionText },
                  context
                })
              );
            } else if (score >= 30 && retriesUsed < this.retryBudget) {
              // 2. Retry mode
              retriesUsed += 1;
              if (!graph.stabilizationActionsTaken) graph.stabilizationActionsTaken = [];
              const actionText = `RETRY_MODE: Planner confidence low (${score.toFixed(2)}). Retrying planning phase (${retriesUsed}/${this.retryBudget}).`;
              graph.stabilizationActionsTaken.push(actionText);
              await this.deps.cognitions.save(graph);

              await this.deps.publisher.publish(
                this.deps.eventFactory.create({
                  type: "COGNITION_ORCHESTRATION_DECISION",
                  aggregateId: executionId,
                  aggregateType: "EXECUTION",
                  payload: { cognitionId, decision: "RETRY", score, details: actionText },
                  context
                })
              );

              const oldPhase = currentPhase;
              currentPhase = "PLAN";
              await this.deps.publisher.publish(
                this.deps.eventFactory.create({
                  type: "COGNITION_PHASE_CHANGED",
                  aggregateId: executionId,
                  aggregateType: "EXECUTION",
                  payload: { cognitionId, from: oldPhase, to: "PLAN" },
                  context
                })
              );
              continue;
            } else if (score >= 20) {
              // 3. Noop fallback mode
              if (!graph.stabilizationActionsTaken) graph.stabilizationActionsTaken = [];
              const actionText = `NOOP_FALLBACK: Planner confidence very low (${score.toFixed(2)}). Routing to noop fallback plan steps.`;
              graph.stabilizationActionsTaken.push(actionText);
              
              const safeNoopOutput = {
                steps: [
                  { id: "noop-fallback", description: "Safe no-op execution fallback due to low planner confidence." }
                ],
                riskAssessment: "LOW"
              };
              node.output = { ...node.output, ...safeNoopOutput };
              carryOver = { ...carryOver, steps: safeNoopOutput.steps };
              await this.deps.cognitions.save(graph);

              await this.deps.publisher.publish(
                this.deps.eventFactory.create({
                  type: "COGNITION_ORCHESTRATION_DECISION",
                  aggregateId: executionId,
                  aggregateType: "EXECUTION",
                  payload: { cognitionId, decision: "NOOP_FALLBACK", score, details: actionText },
                  context
                })
              );
            } else {
              // 4. Clarification mode (Halted)
              graph.autonomyLevel = "HALTED";
              graph.escalationRequired = true;
              if (!graph.stabilizationActionsTaken) graph.stabilizationActionsTaken = [];
              const actionText = `HALTED_AUTONOMOUS_EXECUTION (CLARIFICATION_MODE): Planner confidence critical (${score.toFixed(2)}). Halting execution for user clarification.`;
              graph.stabilizationActionsTaken.push(actionText);
              await this.deps.cognitions.save(graph);

              await this.deps.publisher.publish(
                this.deps.eventFactory.create({
                  type: "COGNITION_ORCHESTRATION_DECISION",
                  aggregateId: executionId,
                  aggregateType: "EXECUTION",
                  payload: { cognitionId, decision: "HALTED", score, details: actionText },
                  context
                })
              );

              await this.markFailed(
                graph,
                `Halt execution: Planner confidence extremely low (${score.toFixed(2)}). Clarification required.`,
                context
              );

              return this.snapshot(cognitionId);
            }
          }

          // Apply standard orchestration decisions
          const decision = makeOrchestrationDecision(node.confidenceScore);

          // Lower execution autonomy / Escalation state
          if (decision.executionAutonomy === "HALTED") {
            graph.autonomyLevel = "HALTED";
            graph.escalationRequired = true;
            if (!graph.stabilizationActionsTaken) graph.stabilizationActionsTaken = [];
            graph.stabilizationActionsTaken.push(
              `HALTED_AUTONOMOUS_EXECUTION: Node ${node.id} confidence extremely low (${node.confidenceScore.toFixed(2)})`
            );
            await this.deps.cognitions.save(graph);
            await this.markFailed(
              graph,
              `Halt autonomous execution: confidence extremely low (${node.confidenceScore.toFixed(2)})`,
              context
            );
            return this.snapshot(cognitionId);
          } else if (decision.executionAutonomy === "DEGRADED") {
            graph.autonomyLevel = "DEGRADED";
          } else {
            graph.autonomyLevel = "FULL";
          }

          // Propagate verifier options
          if (decision.enableMultiVerifier) {
            carryOver = { ...carryOver, enableMultiVerifier: true };
            if (!graph.stabilizationActionsTaken) graph.stabilizationActionsTaken = [];
            if (!graph.stabilizationActionsTaken.includes("MULTI_VERIFIER_ENABLED")) {
              graph.stabilizationActionsTaken.push("MULTI_VERIFIER_ENABLED");
            }
          }

          // Active replanning routing
          if (decision.triggerReplanning && currentPhase !== "PLAN" && currentPhase !== "INIT") {
            if (!graph.stabilizationActionsTaken) graph.stabilizationActionsTaken = [];
            if (!graph.stabilizationActionsTaken.includes(`REPLANNING_TRIGGERED_AT_SEQUENCE_${sequence}`)) {
              graph.stabilizationActionsTaken.push(`REPLANNING_TRIGGERED_AT_SEQUENCE_${sequence}`);
            }
            await this.deps.cognitions.save(graph);

            const oldPhase = currentPhase;
            currentPhase = "PLAN";

            await this.deps.publisher.publish(
              this.deps.eventFactory.create({
                type: "COGNITION_PHASE_CHANGED",
                aggregateId: executionId,
                aggregateType: "EXECUTION",
                payload: { cognitionId, from: oldPhase, to: "PLAN" },
                context
              })
            );

            const handoff = {
              fromNodeId: node.id,
              toRole: "PLANNER" as const,
              reason: `replanning-triggered-by-low-confidence-${node.confidenceScore.toFixed(2)}`,
              carryOver
            };
            graph.handoffs.push(handoff);
            await this.deps.publisher.publish(
              this.deps.eventFactory.create({
                type: "COGNITION_HANDOFF",
                aggregateId: executionId,
                aggregateType: "EXECUTION",
                payload: { cognitionId, handoff, toRole: "PLANNER" },
                context
              })
            );
            continue;
          }
        }

        const transition = CognitionStateMachine.next(currentPhase, roleResult.nextPhase, {
          retryBudget: this.retryBudget,
          retriesUsed
        });
        if (!transition) {
          currentPhase = "COMPLETE";
          break;
        }
        if (transition.consumesRetry) retriesUsed += 1;

        if (transition.to !== currentPhase) {
          await this.deps.publisher.publish(
            this.deps.eventFactory.create({
              type: "COGNITION_PHASE_CHANGED",
              aggregateId: executionId,
              aggregateType: "EXECUTION",
              payload: { cognitionId, from: currentPhase, to: transition.to },
              context
            })
          );
        }

        // Handoff event when role changes.
        if (transition.role !== role && transition.to !== "FAILED" && transition.to !== "COMPLETE") {
          const handoff = {
            fromNodeId: node.id,
            toRole: transition.role,
            reason: roleResult.reason ?? "phase-transition",
            carryOver
          };
          graph.handoffs.push(handoff);
          await this.deps.publisher.publish(
            this.deps.eventFactory.create({
              type: "COGNITION_HANDOFF",
              aggregateId: executionId,
              aggregateType: "EXECUTION",
              payload: { cognitionId, handoff, toRole: transition.role },
              context
            })
          );
        }

        currentPhase = transition.to;
      }

      const completedGraph: CognitionGraph = {
        ...graph,
        phase: currentPhase,
        completedAt: toIso(this.deps.clock.now()),
        output: carryOver
      };
      await this.deps.cognitions.save(completedGraph);

      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: currentPhase === "FAILED" ? "COGNITION_FAILED" : "COGNITION_COMPLETED",
          aggregateId: executionId,
          aggregateType: "EXECUTION",
          payload: { graph: completedGraph },
          context
        })
      );

      return completedGraph;
    } catch (err) {
      // IMPLEMENT COGNITION RECOVERY MODE
      const completedAt = toIso(this.deps.clock.now());
      graph.phase = "FAILED";
      graph.completedAt = completedAt;
      
      const errorMsg = err instanceof Error ? err.message : String(err);
      graph.output = {
        ...carryOver,
        error: {
          message: errorMsg,
          type: err instanceof Error ? err.name : "UnknownError"
        }
      };

      // Preserve cognition state and trace history safely
      try {
        await this.deps.cognitions.save(graph);
      } catch (saveError) {
        // Safe fallback in case DB save fails, continue recovery
      }

      // Emit structured failure intelligence signals
      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: "COGNITION_FAILED",
          aggregateId: executionId,
          aggregateType: "EXECUTION",
          payload: { graph, reason: errorMsg },
          context
        })
      );

      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: "COGNITION_RECOVERY_TRIGGERED",
          aggregateId: executionId,
          aggregateType: "EXECUTION",
          payload: {
            cognitionId,
            errorType: err instanceof Error ? err.name : "UnknownError",
            errorMessage: errorMsg,
            recoverable: (err as any).recoverable ?? true,
            retryable: (err as any).retryable ?? true
          },
          context
        })
      );

      // Bubble up exception wrapped in a structured RuntimeExecutionError if not already structured
      if (
        err instanceof PlannerValidationError ||
        err instanceof LowConfidenceExecutionBlocked ||
        err instanceof ToolContractViolation ||
        err instanceof NodeResolutionFailure
      ) {
        throw err;
      }

      throw new RuntimeExecutionError(
        `Cognition execution encountered fatal error: ${errorMsg}`,
        cognitionId,
        true, // recoverable
        true, // retryable
        err
      );
    }
  }

  private async runRole(
    graph: CognitionGraph,
    agent: RoleAgent,
    phase: CognitionPhase,
    carryOver: Record<string, unknown>,
    seed: string,
    sequence: number,
    context: EventContext,
    input: CognitionStartInput
  ): Promise<CognitionNode> {
    let retrievalDepth = 6;
    const completedNodes = graph.nodes.filter((n) => n.status === "COMPLETED");
    const lastCompleted = completedNodes[completedNodes.length - 1];
    if (lastCompleted && lastCompleted.confidenceScore !== undefined) {
      const dec = makeOrchestrationDecision(lastCompleted.confidenceScore);
      retrievalDepth = retrievalDepth * dec.retrievalDepthMultiplier;
    }
    const memories = await this.deps.memory.search(graph.agentId, input.goal, retrievalDepth);

    let filteredMemories = memories;
    let scoredMemories: ScoredMemory[] = [];
    if (this.deps.memoryTrustEngine) {
      const executionStatusMap = new Map<string, "COMPLETED" | "FAILED" | "RUNNING" >();
      if (this.deps.executions) {
        await Promise.all(
          memories
            .filter((m) => m.executionId)
            .map(async (m) => {
              const exec = await this.deps.executions!.getById(m.executionId!);
              if (exec) {
                executionStatusMap.set(
                  m.executionId!,
                  exec.status === "COMPLETED"
                    ? "COMPLETED"
                    : exec.status === "FAILED"
                    ? "FAILED"
                    : "RUNNING"
                );
              }
            })
        );
      }

      scoredMemories = this.deps.memoryTrustEngine.scoreAndFilter(memories, input.goal, {
        executionStatusMap
      });
      this.deps.memoryTrustEngine.trackRetrievals(memories.map((m) => m.id));
      this.deps.memoryTrustEngine.trackExecutionRetrieval(graph.executionId, memories.map((m) => m.id));

      filteredMemories = scoredMemories
        .filter((sm) => !sm.isSuppressed)
        .sort((a, b) => b.trustScore.overall - a.trustScore.overall)
        .map((sm) => ({
          ...sm.memory,
          metadata: {
            ...sm.memory.metadata,
            trustScore: sm.trustScore,
            freshnessScore: sm.freshnessScore,
            isStale: sm.isStale,
            contaminationAlerts: sm.contaminationAlerts,
            lineage: sm.lineage
          }
        }));

      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: "MEMORY_TRUST_EVALUATED" as any,
          aggregateId: graph.executionId,
          aggregateType: "EXECUTION",
          payload: {
            cognitionId: graph.id,
            scoredMemories
          },
          context
        })
      );
    }

    const inputBundle = {
      phase,
      carryOver,
      taskFingerprint: await fingerprint(input.task)
    };
    const inputFingerprint = await fingerprint(inputBundle);
    const nodeId = deterministicId([graph.executionId, sequence, agent.role, inputFingerprint]);
    const startedAt = toIso(this.deps.clock.now());

    const startedNode: CognitionNode = {
      id: nodeId,
      cognitionId: graph.id,
      executionId: graph.executionId,
      sequence,
      role: agent.role,
      phase,
      status: "RUNNING",
      inputFingerprint,
      input: inputBundle,
      startedAt
    };
    graph.nodes.push(startedNode);
    await this.deps.cognitions.upsertNode(startedNode);
    await this.deps.publisher.publish(
      this.deps.eventFactory.create({
        type: "COGNITION_NODE_STARTED",
        aggregateId: graph.executionId,
        aggregateType: "EXECUTION",
        payload: { node: startedNode },
        context
      })
    );

    const ctx: RoleContext = {
      cognitionId: graph.id,
      executionId: graph.executionId,
      agentId: graph.agentId,
      goal: input.goal,
      task: input.task,
      seed,
      history: [...graph.nodes],
      memories: filteredMemories,
      carryOver,
      // C-1: propagate tenant from the cognition graph so role agents (chiefly
      // MemoryManagerAgent) can stamp tenant_id on persisted memory rows.
      tenantId: graph.tenantId
    };

    try {
      const result = await agent.invoke(ctx);

      // Emit streaming chunks (1 event per chunk) — drives the overlay.
      for (const chunk of result.tokens ?? []) {
        await this.deps.publisher.publish(
          this.deps.eventFactory.create({
            type: "COGNITION_NODE_STREAMING",
            aggregateId: graph.executionId,
            aggregateType: "EXECUTION",
            payload: { nodeId, cognitionId: graph.id, chunk },
            context
          })
        );
      }
      if (result.memoryInfluence?.length) {
        await this.deps.publisher.publish(
          this.deps.eventFactory.create({
            type: "MEMORY_INFLUENCE_RECORDED",
            aggregateId: graph.executionId,
            aggregateType: "EXECUTION",
            payload: { cognitionId: graph.id, nodeId, influence: result.memoryInfluence },
            context
          })
        );
      }

      const completedAt = toIso(this.deps.clock.now());
      const completedNode: CognitionNode = {
        ...startedNode,
        status: "COMPLETED",
        output: { ...result.output, __role: result } as Record<string, unknown>,
        tokenStream: result.tokens,
        uncertainty: result.uncertainty,
        memoryInfluence: result.memoryInfluence,
        completedAt,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime()
      };

      // 1. Calculate, propagate, track degradation, and attribute instability in DAG
      propagateConfidence(completedNode, graph.nodes);
      const score = completedNode.confidenceScore ?? 100;
      const decision = makeOrchestrationDecision(score);

      // Replace placeholder in graph.
      graph.nodes[graph.nodes.length - 1] = completedNode;
      await this.deps.cognitions.upsertNode(completedNode);

      // 2. Emit stateful confidence events
      const priorCompletedNode = completedNodes[completedNodes.length - 1];
      const previousScore = priorCompletedNode?.confidenceScore;

      // Degraded event
      if (completedNode.degradationTracking && 
          ((score < 50 && (previousScore === undefined || previousScore >= 50)) || 
           completedNode.degradationTracking.confidenceDrop > 10)) {
        await this.deps.publisher.publish(
          this.deps.eventFactory.create({
            type: "runtime.confidence.degraded" as any,
            aggregateId: graph.executionId,
            aggregateType: "EXECUTION",
            payload: {
              cognitionId: graph.id,
              nodeId: completedNode.id,
              confidenceScore: score,
              previousConfidenceScore: previousScore,
              degradation: completedNode.degradationTracking.confidenceDrop
            },
            context
          })
        );
      }

      // Critical event
      if (score < 30) {
        await this.deps.publisher.publish(
          this.deps.eventFactory.create({
            type: "runtime.confidence.critical" as any,
            aggregateId: graph.executionId,
            aggregateType: "EXECUTION",
            payload: {
              cognitionId: graph.id,
              nodeId: completedNode.id,
              confidenceScore: score,
              requireEscalation: decision.requireEscalation
            },
            context
          })
        );
      }

      // Recovered event
      if (score >= 50 && previousScore !== undefined && previousScore < 50) {
        await this.deps.publisher.publish(
          this.deps.eventFactory.create({
            type: "runtime.confidence.recovered" as any,
            aggregateId: graph.executionId,
            aggregateType: "EXECUTION",
            payload: {
              cognitionId: graph.id,
              nodeId: completedNode.id,
              confidenceScore: score,
              previousConfidenceScore: previousScore,
              recovery: Number((score - previousScore).toFixed(2))
            },
            context
          })
        );
      }

      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: "COGNITION_NODE_COMPLETED",
          aggregateId: graph.executionId,
          aggregateType: "EXECUTION",
          payload: { node: completedNode, uncertainty: result.uncertainty },
          context
        })
      );
      return completedNode;
    } catch (error) {
      const failedAt = toIso(this.deps.clock.now());
      const failedNode: CognitionNode = {
        ...startedNode,
        status: "FAILED",
        output: { error: error instanceof Error ? error.message : String(error) },
        completedAt: failedAt,
        durationMs: new Date(failedAt).getTime() - new Date(startedAt).getTime()
      };
      graph.nodes[graph.nodes.length - 1] = failedNode;
      await this.deps.cognitions.upsertNode(failedNode);
      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: "COGNITION_NODE_FAILED",
          aggregateId: graph.executionId,
          aggregateType: "EXECUTION",
          payload: { node: failedNode, error: failedNode.output?.error as string },
          context
        })
      );
      return failedNode;
    }
  }

  private async markFailed(graph: CognitionGraph, reason: string, context: EventContext): Promise<void> {
    const failed: CognitionGraph = { ...graph, phase: "FAILED", completedAt: toIso(this.deps.clock.now()) };
    await this.deps.cognitions.save(failed);
    await this.deps.publisher.publish(
      this.deps.eventFactory.create({
        type: "COGNITION_FAILED",
        aggregateId: graph.executionId,
        aggregateType: "EXECUTION",
        payload: { graph: failed, reason } as Record<string, unknown>,
        context
      })
    );
  }

  private async snapshot(cognitionId: string): Promise<CognitionGraph> {
    const graph = await this.deps.cognitions.getById(cognitionId);
    if (!graph) throw new Error(`Cognition ${cognitionId} disappeared`);
    return graph;
  }

  /**
   * Best-effort lookup of the owning execution's tenantId for tenant
   * propagation onto a derived cognition graph. The lookup is intentionally
   * non-fatal — older replay paths may not have the execution row yet.
   */
  private async lookupExecutionTenant(executionId: string): Promise<string | undefined> {
    if (!this.deps.executions) return undefined;
    try {
      const exec = await this.deps.executions.getById(executionId);
      return exec?.tenantId ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async validatePlannerOutput(node: CognitionNode, agentId: string): Promise<void> {
    const cognitionId = node.cognitionId;

    // 1. Validate null/undefined outputs
    if (!node.output) {
      const err = new PlannerValidationError("Planner output is null or undefined", cognitionId);
      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: "PLANNER_VALIDATION_FAILED",
          aggregateId: node.executionId,
          aggregateType: "EXECUTION",
          payload: { error: err.message, cognitionId },
          context: { traceId: node.executionId }
        })
      );
      throw err;
    }

    // 2. Validate node existence
    if (!node.id) {
      const err = new NodeResolutionFailure("Planner node has no ID", cognitionId);
      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: "PLANNER_VALIDATION_FAILED",
          aggregateId: node.executionId,
          aggregateType: "EXECUTION",
          payload: { error: err.message, cognitionId },
          context: { traceId: node.executionId }
        })
      );
      throw err;
    }

    // 3. Validate step arrays
    const steps = node.output.steps;
    if (!steps) {
      const err = new PlannerValidationError("Planner output is missing step array", cognitionId);
      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: "PLANNER_VALIDATION_FAILED",
          aggregateId: node.executionId,
          aggregateType: "EXECUTION",
          payload: { error: err.message, cognitionId },
          context: { traceId: node.executionId }
        })
      );
      throw err;
    }
    if (!Array.isArray(steps)) {
      const err = new PlannerValidationError("Planner steps must be a valid array", cognitionId);
      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: "PLANNER_VALIDATION_FAILED",
          aggregateId: node.executionId,
          aggregateType: "EXECUTION",
          payload: { error: err.message, cognitionId },
          context: { traceId: node.executionId }
        })
      );
      throw err;
    }
    if (steps.length === 0) {
      const err = new PlannerValidationError("Planner plan must have at least one step", cognitionId);
      await this.deps.publisher.publish(
        this.deps.eventFactory.create({
          type: "PLANNER_VALIDATION_FAILED",
          aggregateId: node.executionId,
          aggregateType: "EXECUTION",
          payload: { error: err.message, cognitionId },
          context: { traceId: node.executionId }
        })
      );
      throw err;
    }

    // 4. Validate action/step structure
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as any;
      if (!step || typeof step !== "object") {
        const err = new PlannerValidationError(`Planner step at index ${i} is not a valid object`, cognitionId);
        await this.deps.publisher.publish(
          this.deps.eventFactory.create({
            type: "PLANNER_VALIDATION_FAILED",
            aggregateId: node.executionId,
            aggregateType: "EXECUTION",
            payload: { error: err.message, cognitionId },
            context: { traceId: node.executionId }
          })
        );
        throw err;
      }
      const stepId = step.id || step.action;
      if (!stepId || typeof stepId !== "string" || stepId.trim() === "") {
        const err = new PlannerValidationError(`Planner step at index ${i} has missing or invalid step ID/action`, cognitionId);
        await this.deps.publisher.publish(
          this.deps.eventFactory.create({
            type: "PLANNER_VALIDATION_FAILED",
            aggregateId: node.executionId,
            aggregateType: "EXECUTION",
            payload: { error: err.message, cognitionId },
            context: { traceId: node.executionId }
          })
        );
        throw err;
      }
      if (!step.description || typeof step.description !== "string" || step.description.trim() === "") {
        const err = new PlannerValidationError(`Planner step at index ${i} has missing or invalid description`, cognitionId);
        await this.deps.publisher.publish(
          this.deps.eventFactory.create({
            type: "PLANNER_VALIDATION_FAILED",
            aggregateId: node.executionId,
            aggregateType: "EXECUTION",
            payload: { error: err.message, cognitionId },
            context: { traceId: node.executionId }
          })
        );
        throw err;
      }
    }

    // 5. Retrieve agent and validate execution contracts + tool payloads
    if (this.deps.agents) {
      const agent = await this.deps.agents.getById(agentId);
      if (!agent) {
        const err = new PlannerValidationError(`Agent ${agentId} not found in repository`, cognitionId);
        await this.deps.publisher.publish(
          this.deps.eventFactory.create({
            type: "PLANNER_VALIDATION_FAILED",
            aggregateId: node.executionId,
            aggregateType: "EXECUTION",
            payload: { error: err.message, cognitionId },
            context: { traceId: node.executionId }
          })
        );
        throw err;
      }

      // Check if the plan is trying to use tools or steps that violate agent tool contracts
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as any;
        const stepToolName = step.toolName || step.tool || (step.action && step.action.includes(".") ? step.action : undefined);
        if (stepToolName) {
          // Validate tool existence in agent's registered tools
          const agentTool = agent.tools.find(t => t.name === stepToolName);
          if (!agentTool) {
            const err = new ToolContractViolation(
              `Tool '${stepToolName}' referenced in plan is not registered on agent '${agent.name}'`,
              cognitionId,
              true,
              false,
              stepToolName
            );
            await this.deps.publisher.publish(
              this.deps.eventFactory.create({
                type: "PLANNER_VALIDATION_FAILED",
                aggregateId: node.executionId,
                aggregateType: "EXECUTION",
                payload: { error: err.message, cognitionId, toolName: stepToolName },
                context: { traceId: node.executionId }
              })
            );
            throw err;
          }
          if (!agentTool.enabled) {
            const err = new ToolContractViolation(
              `Tool '${stepToolName}' referenced in plan is disabled on agent '${agent.name}'`,
              cognitionId,
              true,
              false,
              stepToolName
            );
            await this.deps.publisher.publish(
              this.deps.eventFactory.create({
                type: "PLANNER_VALIDATION_FAILED",
                aggregateId: node.executionId,
                aggregateType: "EXECUTION",
                payload: { error: err.message, cognitionId, toolName: stepToolName },
                context: { traceId: node.executionId }
              })
            );
            throw err;
          }

          // Validate payload schema / arguments for known built-in tools
          const stepArgs = step.args || step.payload || step.arguments;
          if (stepArgs && typeof stepArgs === "object") {
            if (stepToolName === "web.search") {
              const query = stepArgs.query || stepArgs.q;
              if (query === undefined || query === null || String(query).trim() === "") {
                const err = new ToolContractViolation(
                  `Tool 'web.search' payload schema violation: 'query' argument is required and must be non-empty`,
                  cognitionId,
                  true,
                  false,
                  "web.search",
                  { query: "Required" }
                );
                await this.deps.publisher.publish(
                  this.deps.eventFactory.create({
                    type: "PLANNER_VALIDATION_FAILED",
                    aggregateId: node.executionId,
                    aggregateType: "EXECUTION",
                    payload: { error: err.message, cognitionId, toolName: "web.search" },
                    context: { traceId: node.executionId }
                  })
                );
                throw err;
              }
            } else if (stepToolName === "file.read") {
              const pathArg = stepArgs.path;
              if (pathArg === undefined || pathArg === null || String(pathArg).trim() === "") {
                const err = new ToolContractViolation(
                  `Tool 'file.read' payload schema violation: 'path' argument is required and must be non-empty`,
                  cognitionId,
                  true,
                  false,
                  "file.read",
                  { path: "Required" }
                );
                await this.deps.publisher.publish(
                  this.deps.eventFactory.create({
                    type: "PLANNER_VALIDATION_FAILED",
                    aggregateId: node.executionId,
                    aggregateType: "EXECUTION",
                    payload: { error: err.message, cognitionId, toolName: "file.read" },
                    context: { traceId: node.executionId }
                  })
                );
                throw err;
              }
            } else if (stepToolName === "code.execute") {
              const codeArg = stepArgs.code;
              if (codeArg === undefined || codeArg === null || String(codeArg).trim() === "") {
                const err = new ToolContractViolation(
                  `Tool 'code.execute' payload schema violation: 'code' argument is required and must be non-empty`,
                  cognitionId,
                  true,
                  false,
                  "code.execute",
                  { code: "Required" }
                );
                await this.deps.publisher.publish(
                  this.deps.eventFactory.create({
                    type: "PLANNER_VALIDATION_FAILED",
                    aggregateId: node.executionId,
                    aggregateType: "EXECUTION",
                    payload: { error: err.message, cognitionId, toolName: "code.execute" },
                    context: { traceId: node.executionId }
                  })
                );
                throw err;
              }
            }
          }
        }
      }
    }

    // Emit validation passed event
    await this.deps.publisher.publish(
      this.deps.eventFactory.create({
        type: "PLANNER_VALIDATION_PASSED",
        aggregateId: node.executionId,
        aggregateType: "EXECUTION",
        payload: { cognitionId, stepsCount: steps.length },
        context: { traceId: node.executionId }
      })
    );
  }
}

function contextTenantId(context?: EventContext): string | undefined {
  if (!context) return undefined;
  const value = (context as unknown as Record<string, unknown>).tenantId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
