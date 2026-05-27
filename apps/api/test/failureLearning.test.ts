import { describe, expect, it, beforeEach } from "vitest";
import { FailureLearning } from "../src/runtime/failure/failureLearning.js";
import {
  InMemoryAnomalyIndex,
  InMemoryFailureSignatureStore,
  InMemoryReplayOutcomeStore
} from "../src/infrastructure/persistence/inMemoryCognitionStores.js";
import { deriveSignaturePayload, normalizeSummary } from "../src/domain/signatureHashing.js";
import type { FailureSignal, FailureSignalKind, FailureSeverity } from "../src/domain/failure.js";
import type { ExecutionHealthSnapshot } from "../src/domain/executionHealth.js";
import type { ReplayOutcome } from "../src/domain/failureLearning.js";

/**
 * Failure learning tests focus on cluster identity, signature normalisation,
 * anomaly indexing, branch comparison correctness, and repair-effectiveness
 * aggregation. All inputs are deterministic — same input must always produce
 * same signature ID.
 */

function makeSignal(over: Partial<FailureSignal> & Pick<FailureSignal, "kind" | "summary"> & { score?: number; sev?: FailureSeverity }): FailureSignal {
  return {
    id: over.id ?? `s-${Math.random()}`,
    executionId: over.executionId ?? "exec-1",
    cognitionId: over.cognitionId ?? "cog-1",
    score: over.score ?? 0.7,
    severity: over.sev ?? "MEDIUM",
    summary: over.summary,
    evidence: over.evidence ?? [],
    detectedAt: over.detectedAt ?? new Date().toISOString(),
    detectedBy: over.detectedBy ?? "test",
    kind: over.kind
  };
}

function makeOutcome(over: Partial<ReplayOutcome> & Pick<ReplayOutcome, "cognitionId" | "kind">): ReplayOutcome {
  return {
    executionId: `exec-${over.cognitionId}`,
    healthScore: 50,
    failureSignalCount: 0,
    observedSignalKinds: [],
    succeeded: false,
    recordedAt: new Date().toISOString(),
    ...over
  } as ReplayOutcome;
}

describe("signatureHashing", () => {
  describe("normalizeSummary", () => {
    it("strips numbers, IDs, quoted strings, and timestamps", () => {
      const summary = 'Tool "search_web" called 7x with identical args at 2024-01-01T12:34:56Z (id abc123def456)';
      const normalized = normalizeSummary(summary);
      expect(normalized).not.toMatch(/\d+x/);
      expect(normalized).not.toMatch(/\d{4}-\d{2}/);
      expect(normalized).not.toMatch(/abc123def456/);
      expect(normalized).toContain("<n>");
      expect(normalized).toContain("<str>");
      expect(normalized).toContain("<id>");
      expect(normalized).toContain("<ts>");
    });

    it("produces the same template for two semantically identical summaries with different details", () => {
      const a = 'Tool "search_web" called 3x with identical args';
      const b = 'Tool "fetch_api" called 17x with identical args';
      expect(normalizeSummary(a)).toBe(normalizeSummary(b));
    });
  });

  describe("deriveSignaturePayload", () => {
    it("two signals describing the same failure pattern produce the same signature ID", () => {
      const a = makeSignal({
        kind: "TOOL_MISUSE",
        summary: 'Tool "search" called 3x with identical args',
        evidence: [{ metric: { repetitions: 3 } }]
      });
      const b = makeSignal({
        kind: "TOOL_MISUSE",
        executionId: "different-exec",
        cognitionId: "different-cog",
        summary: 'Tool "fetch" called 7x with identical args',
        evidence: [{ metric: { repetitions: 7 } }]
      });
      const sigA = deriveSignaturePayload(a);
      const sigB = deriveSignaturePayload(b);
      expect(sigA.id).toBe(sigB.id);
    });

    it("different failure kinds always produce different signature IDs", () => {
      const summary = "agent stuck in loop";
      const a = makeSignal({ kind: "HALLUCINATION", summary });
      const b = makeSignal({ kind: "CONTRADICTION", summary });
      expect(deriveSignaturePayload(a).id).not.toBe(deriveSignaturePayload(b).id);
    });

    it("different evidence shapes produce different signatures even for the same kind", () => {
      const a = makeSignal({ kind: "HALLUCINATION", summary: "foo", evidence: [{ metric: { groundingDeficit: 0.5 } }] });
      const b = makeSignal({ kind: "HALLUCINATION", summary: "foo", evidence: [{ metric: { uncertaintyOverall: 0.8 } }] });
      expect(deriveSignaturePayload(a).id).not.toBe(deriveSignaturePayload(b).id);
    });
  });
});

describe("InMemoryFailureSignatureStore", () => {
  let store: InMemoryFailureSignatureStore;
  beforeEach(() => { store = new InMemoryFailureSignatureStore(); });

  it("creates a new signature on first observation", async () => {
    const sig = await store.observe(makeSignal({ kind: "HALLUCINATION", summary: 'High-risk output at 80%' }));
    expect(sig.occurrenceCount).toBe(1);
    expect(sig.examples).toHaveLength(1);
    expect(sig.exampleExecutionIds).toEqual(["exec-1"]);
  });

  it("increments count when the same signature is observed twice", async () => {
    const s1 = makeSignal({ kind: "HALLUCINATION", summary: 'High-risk output at 80%', executionId: "exec-A" });
    const s2 = makeSignal({ kind: "HALLUCINATION", summary: 'High-risk output at 92%', executionId: "exec-B" });
    await store.observe(s1);
    const sig = await store.observe(s2);
    expect(sig.occurrenceCount).toBe(2);
    expect(sig.exampleExecutionIds).toContain("exec-A");
    expect(sig.exampleExecutionIds).toContain("exec-B");
  });

  it("tracks severity distribution", async () => {
    await store.observe(makeSignal({ kind: "CONTRADICTION", summary: "x", sev: "HIGH" }));
    await store.observe(makeSignal({ kind: "CONTRADICTION", summary: "x", sev: "HIGH" }));
    await store.observe(makeSignal({ kind: "CONTRADICTION", summary: "x", sev: "MEDIUM" }));
    const clusters = await store.listClusters(10);
    expect(clusters[0].signature.severityDistribution.HIGH).toBe(2);
    expect(clusters[0].signature.severityDistribution.MEDIUM).toBe(1);
  });

  it("caps examples at 5 most-recent", async () => {
    for (let i = 0; i < 10; i++) {
      await store.observe(makeSignal({
        id: `s-${i}`,
        kind: "RECURSION",
        summary: `loop detected`,
        executionId: `exec-${i}`
      }));
    }
    const clusters = await store.listClusters(10);
    expect(clusters[0].signature.examples.length).toBeLessThanOrEqual(5);
    expect(clusters[0].signature.occurrenceCount).toBe(10);
  });

  it("listHot returns only clusters above the heat threshold", async () => {
    await store.observe(makeSignal({ kind: "HALLUCINATION", summary: "fresh", detectedAt: new Date().toISOString() }));
    const hot = await store.listHot(0.2, 10);
    expect(hot.length).toBeGreaterThan(0);
    expect(hot[0].heatScore).toBeGreaterThanOrEqual(0.2);
  });
});

describe("FailureLearning", () => {
  let signatures: InMemoryFailureSignatureStore;
  let anomalies: InMemoryAnomalyIndex;
  let outcomes: InMemoryReplayOutcomeStore;
  let learning: FailureLearning;

  beforeEach(() => {
    signatures = new InMemoryFailureSignatureStore();
    anomalies = new InMemoryAnomalyIndex();
    outcomes = new InMemoryReplayOutcomeStore();
    learning = new FailureLearning(signatures, anomalies, outcomes);
  });

  describe("observeSignal", () => {
    it("reports isNew=true on first sighting", async () => {
      const { isNew } = await learning.observeSignal(makeSignal({ kind: "HALLUCINATION", summary: "foo" }));
      expect(isNew).toBe(true);
    });

    it("reports isNew=false on second matching sighting", async () => {
      await learning.observeSignal(makeSignal({ kind: "HALLUCINATION", summary: "foo at 50%" }));
      const { isNew } = await learning.observeSignal(makeSignal({ kind: "HALLUCINATION", summary: "foo at 80%" }));
      expect(isNew).toBe(false);
    });
  });

  describe("indexAnomaly", () => {
    function makeSnapshot(anomalyValue: number | null): ExecutionHealthSnapshot {
      return {
        executionId: "exec-1",
        cognitionId: "cog-1",
        agentId: "agent-1",
        healthScore: 50,
        grade: "C",
        confidence: { value: 0.8, sampleSize: 1, rationale: "", components: {}, weakestNodeIds: [] },
        stability: { value: null, sampleSize: 0, rationale: "", components: {}, baselineExecutionCount: 0, outputAgreementRate: 0 },
        toolReliability: { value: null, sampleSize: 0, rationale: "", components: {}, perTool: [] },
        consistency: { value: 1, sampleSize: 1, rationale: "", components: {}, contradictionSignals: 0, trueLoopSignals: 0, verifierRejections: 0, sameRoleOutputDivergence: 0 },
        anomaly: anomalyValue === null ? {
          value: null,
          sampleSize: 0,
          rationale: "",
          components: {},
          dimensions: {} as ExecutionHealthSnapshot["anomaly"]["dimensions"],
          baselineExecutionCount: 0
        } : {
          value: anomalyValue,
          sampleSize: 8,
          rationale: "",
          components: {},
          topDimension: "tokenTotal",
          dimensions: {
            stepCount: { observed: 5, baselineMedian: 5, robustZScore: 0 },
            nodeCount: { observed: 5, baselineMedian: 5, robustZScore: 0 },
            tokenTotal: { observed: 10_000, baselineMedian: 1000, robustZScore: 9.5 },
            durationMs: { observed: 1000, baselineMedian: 1000, robustZScore: 0 },
            signalDensity: { observed: 0, baselineMedian: 0, robustZScore: 0 },
            toolCallCount: { observed: 1, baselineMedian: 1, robustZScore: 0 }
          },
          baselineExecutionCount: 8
        },
        observedSignalKinds: [],
        computedAt: new Date().toISOString(),
        computationDurationMs: 1
      };
    }

    it("skips indexing when anomaly score is below the threshold", async () => {
      const entry = await learning.indexAnomaly(makeSnapshot(0.3), 0.5);
      expect(entry).toBeNull();
    });

    it("skips indexing when anomaly is null (no baseline)", async () => {
      const entry = await learning.indexAnomaly(makeSnapshot(null));
      expect(entry).toBeNull();
    });

    it("indexes anomalous executions and exposes them via query()", async () => {
      const entry = await learning.indexAnomaly(makeSnapshot(0.9), 0.5);
      expect(entry).not.toBeNull();
      expect(entry!.topDimension).toBe("tokenTotal");
      const results = await anomalies.query({ minScore: 0.5 });
      expect(results).toHaveLength(1);
      expect(results[0].executionId).toBe("exec-1");
    });
  });

  describe("compareOutcomes", () => {
    it("returns undefined when source outcome wasn't recorded", async () => {
      const cmp = await learning.compareOutcomes("missing-source");
      expect(cmp).toBeUndefined();
    });

    it("computes resolved/persistent/new signal kinds correctly", async () => {
      const source = makeOutcome({
        cognitionId: "src",
        kind: "SOURCE",
        observedSignalKinds: ["HALLUCINATION", "CONTRADICTION"] as FailureSignalKind[],
        healthScore: 40,
        totalTokens: 1000
      });
      const branch = makeOutcome({
        cognitionId: "br1",
        kind: "BRANCH",
        sourceCognitionId: "src",
        observedSignalKinds: ["CONTRADICTION", "RECURSION"] as FailureSignalKind[],
        branchOverride: { type: "MODEL", description: "switched to model X" },
        healthScore: 70,
        totalTokens: 1500
      });
      await learning.recordOutcome(source);
      await learning.recordOutcome(branch);

      const cmp = await learning.compareOutcomes("src");
      expect(cmp).toBeDefined();
      expect(cmp!.branches).toHaveLength(1);
      const delta = cmp!.branches[0];
      expect(delta.resolvedSignalKinds).toEqual(["HALLUCINATION"]);
      expect(delta.persistentSignalKinds).toEqual(["CONTRADICTION"]);
      expect(delta.newSignalKinds).toEqual(["RECURSION"]);
      expect(delta.netSignalDelta).toBe(0);  // 1 resolved - 1 new = 0
      expect(delta.healthScoreDelta).toBe(30);
      expect(delta.tokenDelta).toBe(500);
    });

    it("recommends the branch with the largest healthScoreDelta", async () => {
      const source = makeOutcome({ cognitionId: "src", kind: "SOURCE", healthScore: 40 });
      await learning.recordOutcome(source);
      await learning.recordOutcome(makeOutcome({
        cognitionId: "br1", kind: "BRANCH", sourceCognitionId: "src",
        branchOverride: { type: "INPUT", description: "x" }, healthScore: 50
      }));
      await learning.recordOutcome(makeOutcome({
        cognitionId: "br2", kind: "BRANCH", sourceCognitionId: "src",
        branchOverride: { type: "MODEL", description: "x" }, healthScore: 85
      }));
      await learning.recordOutcome(makeOutcome({
        cognitionId: "br3", kind: "BRANCH", sourceCognitionId: "src",
        branchOverride: { type: "SEED", description: "x" }, healthScore: 60
      }));
      const cmp = await learning.compareOutcomes("src");
      expect(cmp!.bestBranchCognitionId).toBe("br2");
    });
  });

  describe("computeRepairEffectiveness", () => {
    it("aggregates per (kind, repairType) and flags confident vs not", async () => {
      const source = makeOutcome({
        cognitionId: "src",
        kind: "SOURCE",
        observedSignalKinds: ["HALLUCINATION"] as FailureSignalKind[],
        healthScore: 30,
        totalTokens: 1000
      });
      await learning.recordOutcome(source);
      // 6 model-swap branches, 5 resolve hallucination
      for (let i = 0; i < 6; i++) {
        await learning.recordOutcome(makeOutcome({
          cognitionId: `m${i}`, kind: "BRANCH", sourceCognitionId: "src",
          branchOverride: { type: "MODEL", description: "swap" },
          observedSignalKinds: (i === 5 ? ["HALLUCINATION"] : []) as FailureSignalKind[],
          healthScore: i === 5 ? 35 : 80, totalTokens: 1100
        }));
      }
      // 2 input-override branches, only 1 resolves (small sample → not confident)
      await learning.recordOutcome(makeOutcome({
        cognitionId: "i1", kind: "BRANCH", sourceCognitionId: "src",
        branchOverride: { type: "INPUT", description: "tweak" },
        observedSignalKinds: [], healthScore: 70, totalTokens: 1000
      }));
      await learning.recordOutcome(makeOutcome({
        cognitionId: "i2", kind: "BRANCH", sourceCognitionId: "src",
        branchOverride: { type: "INPUT", description: "tweak" },
        observedSignalKinds: ["HALLUCINATION"] as FailureSignalKind[], healthScore: 40, totalTokens: 1100
      }));

      const scores = await learning.computeRepairEffectiveness();
      const modelScore = scores.find((s) => s.failureKind === "HALLUCINATION" && s.repairType === "MODEL");
      const inputScore = scores.find((s) => s.failureKind === "HALLUCINATION" && s.repairType === "INPUT");

      expect(modelScore).toBeDefined();
      expect(modelScore!.sampleSize).toBe(6);
      expect(modelScore!.resolutionRate).toBeCloseTo(5 / 6, 2);
      expect(modelScore!.confident).toBe(true);  // ≥ 5

      expect(inputScore).toBeDefined();
      expect(inputScore!.sampleSize).toBe(2);
      expect(inputScore!.confident).toBe(false); // < 5
    });
  });
});
