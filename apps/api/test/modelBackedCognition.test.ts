import { describe, expect, it, vi } from "vitest";
import { CognitionOrchestrator } from "../src/runtime/cognition/orchestrator.js";
import { PlannerAgent } from "../src/runtime/cognition/agents/plannerAgent.js";
import { ExecutorAgent } from "../src/runtime/cognition/agents/executorAgent.js";
import { VerifierAgent } from "../src/runtime/cognition/agents/verifierAgent.js";
import { CriticAgent } from "../src/runtime/cognition/agents/criticAgent.js";
import { MemoryManagerAgent } from "../src/runtime/cognition/agents/memoryManagerAgent.js";
import {
  InMemoryCognitionRepository,
  InMemoryLineageStore
} from "../src/infrastructure/persistence/inMemoryCognitionStores.js";
import { InMemoryMemoryRepository } from "../src/infrastructure/persistence/inMemoryStores.js";
import { SystemClock } from "../src/shared/clock.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import type { ModelProvider } from "../src/domain/ports.js";
import type { CognitionNode } from "../src/domain/cognition.js";

/**
 * Integration: a cognition driven by a NON-deterministic (model-backed)
 * provider completes the full plan→execute→verify→critique→memory→complete
 * loop, and the planner node is stamped `modelBacked: true`. This is the path
 * the runtime takes when MODEL_PROVIDER != "deterministic".
 *
 * The stub provider returns a single object that satisfies every role:
 *   • planner reads `steps`
 *   • verifier reads `verdict` / `score`
 *   • executor consumes the whole object as its modelOutput
 * and streams a high-confidence token so no confidence halt fires.
 */
function stubModelProvider(): ModelProvider {
  return {
    async complete({ onToken }) {
      onToken?.("ok", 1.0);
      return {
        output: {
          steps: [
            { id: "analyse", description: "Analyse the incident" },
            { id: "remediate", description: "Propose a remediation" }
          ],
          verdict: "PASS",
          score: 0.95,
          answer: "Incident summarised; remediation proposed."
        },
        tokenUsage: { prompt: 8, completion: 12, total: 20 }
      };
    }
  };
}

describe("Model-backed cognition (non-deterministic provider) completes", () => {
  it("runs the full loop to COMPLETE with modelBacked planner output", async () => {
    const provider = stubModelProvider();
    const cognitions = new InMemoryCognitionRepository();
    const lineage = new InMemoryLineageStore();
    const memory = new InMemoryMemoryRepository();
    const clock = new SystemClock();
    const eventFactory = new EventFactory(clock);
    const publisher = { publish: vi.fn() } as any;

    const orchestrator = new CognitionOrchestrator({
      cognitions,
      lineage,
      memory,
      publisher,
      eventFactory,
      clock,
      roles: {
        PLANNER: new PlannerAgent(provider),
        EXECUTOR: new ExecutorAgent(provider),
        VERIFIER: new VerifierAgent(provider),
        CRITIC: new CriticAgent(),
        MEMORY_MANAGER: new MemoryManagerAgent(memory, clock)
      }
    });

    const graph = await orchestrator.run(
      { agentId: "agent-1", goal: "Summarise the incident and propose a fix", task: { prompt: "go" } },
      { traceId: "trace-mb-1" } as any
    );

    // The full loop reached COMPLETE — model-backed roles do not halt a clean run.
    expect(graph.phase).toBe("COMPLETE");

    const nodes = graph.nodes as CognitionNode[];
    const planner = nodes.find((n) => n.role === "PLANNER");
    expect(planner).toBeTruthy();
    expect((planner!.output as Record<string, unknown>)?.modelBacked).toBe(true);
    // The model-produced steps were used.
    expect(Array.isArray((planner!.output as Record<string, unknown>)?.steps)).toBe(true);

    // The verifier adjudicated via the model (PASS) — present and completed.
    const verifier = nodes.find((n) => n.role === "VERIFIER");
    expect(verifier).toBeTruthy();
    expect(verifier!.status).toBe("COMPLETED");
  });
});
