import type { FailureSignal, FailureSignalKind } from "../../domain/failure.js";
import type {
  AnomalyIndex,
  AnomalyIndexEntry,
  BranchOutcomeDelta,
  FailureCluster,
  FailureSignature,
  FailureSignatureStore,
  RepairEffectivenessScore,
  RepairType,
  ReplayOutcome,
  ReplayOutcomeComparison,
  ReplayOutcomeStore
} from "../../domain/failureLearning.js";
import type { ExecutionHealthSnapshot } from "../../domain/executionHealth.js";
import { deriveSignaturePayload } from "../../domain/signatureHashing.js";

/**
 * Failure Learning — Phase 7 production implementation.
 *
 * WHAT IT DOES:
 *   Turns the append-only failure-signal stream + execution outcomes into a
 *   queryable knowledge base:
 *
 *     1. observeSignal(signal)          — cluster the signal by signature; emit
 *                                          a pattern-observed event if new.
 *     2. indexAnomaly(snapshot)         — index an anomalous execution.
 *     3. recordOutcome(outcome)         — persist a final outcome (source or branch).
 *     4. compareOutcomes(sourceId)      — score each branch against its source.
 *     5. computeRepairEffectiveness()   — aggregate per (failureKind × repairType)
 *                                          what works.
 *
 *   The clustering, signature derivation, and effectiveness scoring are all
 *   deterministic. No ML, no embeddings, no LLM — Phase 7 needs production
 *   reliability before sophistication. A future phase can layer semantic
 *   similarity on top without changing this contract.
 *
 * OPERATIONAL USEFULNESS:
 *   - Triage: operators see "this failure has happened 47 times, here are the
 *     5 most recent executions" instead of one isolated signal.
 *   - Repair-by-recommendation: "for HALLUCINATION signals, MODEL-swap branches
 *     resolved 73% of cases vs INPUT-override at 41%" — the platform proposes
 *     the override most likely to work.
 *   - Regression detection: a new cluster appearing today with 0 instances
 *     yesterday is a *new* failure mode — worth alerting on.
 *   - Anomaly inbox: filterable list of unusual executions for operator review,
 *     even when no signal fired.
 *
 * REPLAY/DEBUGGING VALUE:
 *   - Every signature carries up to 5 example signals → 5 example executions →
 *     5 replay anchors. From a cluster page, click to replay any instance.
 *   - Outcome comparisons surface healthScoreDelta and resolved/persistent/new
 *     signal kinds so an operator can tell exactly what the branch fixed.
 *
 * FALSE-POSITIVE / FALSE-NEGATIVE RISKS:
 *   - Signature normalization can collapse semantically different failures with
 *     the same template. Mitigated by including metric-key shape, role, and
 *     analyzer name in the hash. If you see one cluster with very mixed
 *     examples, refine signatureHashing.ts.
 *   - Repair effectiveness rates are confounded by *which signals were present
 *     beyond the target*: a HALLUCINATION + RECURSION execution might be
 *     "fixed" because the override happened to suppress the recursion, not the
 *     hallucination. The persistent/resolved kind tracking surfaces this; the
 *     `confident` flag requires ≥ minSampleSize before recommending.
 */
export class FailureLearning {
  /** Per-(kind, repairType) sample size required before the score is `confident`. */
  static readonly MIN_REPAIR_SAMPLE_SIZE = 5;
  /** Heat-score threshold above which a cluster is treated as "active". */
  static readonly HOT_CLUSTER_THRESHOLD = 0.20;

  constructor(
    private readonly signatures: FailureSignatureStore,
    private readonly anomalyIndex: AnomalyIndex,
    private readonly outcomes: ReplayOutcomeStore
  ) {}

  // ── Signature recording ────────────────────────────────────────────────────

  /**
   * Record a single signal. Returns the signature it matched (or was created
   * for) and whether this was the first time the signature was seen.
   *
   * Idempotency: callers may pass the same signal twice (e.g., re-analysis);
   * the underlying store de-duplicates by signal.id within the example list.
   */
  async observeSignal(signal: FailureSignal): Promise<{ signature: FailureSignature; isNew: boolean }> {
    // Compute the signature ID locally (matching the store's hash) so we can
    // detect whether this is a first sighting without race-ing the store.
    const probe = deriveSignaturePayload(signal);
    const existing = await this.signatures.getById(probe.id);
    const isNew = existing === undefined;
    const signature = await this.signatures.observe(signal);
    return { signature, isNew };
  }

  // ── Anomaly indexing ───────────────────────────────────────────────────────

  /**
   * Index an execution as anomalous when its health snapshot has an anomaly
   * score above the minScore threshold. Below threshold: not indexed (no-op).
   * Threshold default 0.5 chosen so genuinely normal runs don't pollute the
   * anomaly inbox.
   */
  async indexAnomaly(snapshot: ExecutionHealthSnapshot, minScore = 0.5): Promise<AnomalyIndexEntry | null> {
    const score = snapshot.anomaly.value;
    if (score === null || score < minScore || !snapshot.anomaly.topDimension) return null;

    const entry: AnomalyIndexEntry = {
      executionId: snapshot.executionId,
      agentId: snapshot.agentId,
      anomalyScore: score,
      topDimension: snapshot.anomaly.topDimension,
      topRobustZScore: snapshot.anomaly.dimensions[snapshot.anomaly.topDimension]?.robustZScore ?? 0,
      indexedAt: snapshot.computedAt
    };
    await this.anomalyIndex.index(entry);
    return entry;
  }

  // ── Replay outcomes ────────────────────────────────────────────────────────

  /** Persist a final outcome. Outcome should be recorded once the execution reaches a terminal state. */
  async recordOutcome(outcome: ReplayOutcome): Promise<void> {
    await this.outcomes.record(outcome);
  }

  /**
   * Compare every branch of a source against its source outcome. Returns
   * undefined when the source itself hasn't been recorded yet (callers should
   * record source before branches in the normal flow).
   */
  async compareOutcomes(sourceCognitionId: string): Promise<ReplayOutcomeComparison | undefined> {
    const all = await this.outcomes.listAll();
    const source = all.find((o) => o.kind === "SOURCE" && o.cognitionId === sourceCognitionId);
    if (!source) return undefined;
    const branches = all.filter((o) => o.kind === "BRANCH" && o.sourceCognitionId === sourceCognitionId);

    const deltas: BranchOutcomeDelta[] = branches.map((b) => computeBranchDelta(source, b));

    // Recommended branch: highest healthScoreDelta, tiebreak by netSignalDelta.
    let best: BranchOutcomeDelta | undefined;
    for (const d of deltas) {
      if (
        !best ||
        d.healthScoreDelta > best.healthScoreDelta ||
        (d.healthScoreDelta === best.healthScoreDelta && d.netSignalDelta > best.netSignalDelta)
      ) {
        best = d;
      }
    }

    return {
      sourceOutcome: source,
      branches: deltas,
      bestBranchCognitionId: best?.branchOutcome.cognitionId,
      comparedAt: new Date().toISOString()
    };
  }

  // ── Repair effectiveness aggregation ───────────────────────────────────────

  /**
   * Aggregate per (failureKind × repairType) statistics across all recorded
   * outcomes. Returns one score per observed pair. Pairs with samples below
   * MIN_REPAIR_SAMPLE_SIZE have `confident=false` and should not drive UI
   * recommendations (they can still be inspected).
   *
   * Algorithm:
   *   - Walk every BRANCH outcome.
   *   - Pair it with its SOURCE outcome.
   *   - For each signal kind in source.observedSignalKinds:
   *       - resolved if not in branch.observedSignalKinds
   *       - persistent if still in branch
   *   - Accumulate per (kind, repairType): resolutions, regressions, deltas.
   */
  async computeRepairEffectiveness(): Promise<RepairEffectivenessScore[]> {
    const all = await this.outcomes.listAll();
    const sourcesById = new Map<string, ReplayOutcome>();
    for (const o of all) {
      if (o.kind === "SOURCE") sourcesById.set(o.cognitionId, o);
    }
    const branches = all.filter((o): o is ReplayOutcome & { branchOverride: NonNullable<ReplayOutcome["branchOverride"]> } =>
      o.kind === "BRANCH" && o.branchOverride !== undefined
    );

    // accumulator key: `${kind}:${repairType}`
    type Acc = {
      kind: FailureSignalKind;
      repairType: RepairType;
      sampleSize: number;
      resolutions: number;
      regressions: number;
      healthDeltaSum: number;
      tokenDeltaSum: number;
      tokenDeltaCount: number;
    };
    const accs = new Map<string, Acc>();

    for (const branch of branches) {
      const source = branch.sourceCognitionId ? sourcesById.get(branch.sourceCognitionId) : undefined;
      if (!source) continue;
      const repairType = branch.branchOverride.type;
      const healthDelta = branch.healthScore - source.healthScore;
      const tokenDelta = branch.totalTokens !== undefined && source.totalTokens !== undefined
        ? branch.totalTokens - source.totalTokens
        : undefined;
      const sourceKinds = new Set(source.observedSignalKinds);
      const branchKinds = new Set(branch.observedSignalKinds);
      const newKinds = [...branchKinds].filter((k) => !sourceKinds.has(k));

      for (const kind of sourceKinds) {
        const resolvedForThisKind = !branchKinds.has(kind);
        const key = `${kind}:${repairType}`;
        const acc = accs.get(key) ?? {
          kind, repairType,
          sampleSize: 0, resolutions: 0, regressions: 0,
          healthDeltaSum: 0, tokenDeltaSum: 0, tokenDeltaCount: 0
        };
        acc.sampleSize += 1;
        if (resolvedForThisKind) acc.resolutions += 1;
        // A regression on this kind = the branch introduced a NEW kind not in
        // source. We count regression once per branch (not per source kind).
        if (newKinds.length > 0) acc.regressions += 1 / sourceKinds.size;
        acc.healthDeltaSum += healthDelta;
        if (tokenDelta !== undefined) {
          acc.tokenDeltaSum += tokenDelta;
          acc.tokenDeltaCount += 1;
        }
        accs.set(key, acc);
      }
    }

    const computedAt = new Date().toISOString();
    return Array.from(accs.values()).map((a) => ({
      failureKind: a.kind,
      repairType: a.repairType,
      sampleSize: a.sampleSize,
      resolutionRate: round(a.sampleSize > 0 ? a.resolutions / a.sampleSize : 0),
      regressionRate: round(a.sampleSize > 0 ? a.regressions / a.sampleSize : 0),
      meanHealthDelta: round(a.sampleSize > 0 ? a.healthDeltaSum / a.sampleSize : 0),
      meanTokenDelta: round(a.tokenDeltaCount > 0 ? a.tokenDeltaSum / a.tokenDeltaCount : 0),
      confident: a.sampleSize >= FailureLearning.MIN_REPAIR_SAMPLE_SIZE,
      computedAt
    }));
  }

  // ── Cluster queries ────────────────────────────────────────────────────────

  /** Top failure clusters by total size — feed the "common failures" dashboard. */
  async topClusters(limit = 20): Promise<FailureCluster[]> {
    return this.signatures.listClusters(limit);
  }

  /** Hot clusters — recently active. Feeds the "what's burning right now" panel. */
  async hotClusters(limit = 10): Promise<FailureCluster[]> {
    return this.signatures.listHot(FailureLearning.HOT_CLUSTER_THRESHOLD, limit);
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function computeBranchDelta(source: ReplayOutcome, branch: ReplayOutcome): BranchOutcomeDelta {
  const sourceKinds = new Set(source.observedSignalKinds);
  const branchKinds = new Set(branch.observedSignalKinds);
  const resolved = [...sourceKinds].filter((k) => !branchKinds.has(k)) as FailureSignalKind[];
  const introduced = [...branchKinds].filter((k) => !sourceKinds.has(k)) as FailureSignalKind[];
  const persistent = [...sourceKinds].filter((k) => branchKinds.has(k)) as FailureSignalKind[];
  const tokenDelta = source.totalTokens !== undefined && branch.totalTokens !== undefined
    ? branch.totalTokens - source.totalTokens
    : undefined;
  return {
    branchOutcome: branch,
    healthScoreDelta: branch.healthScore - source.healthScore,
    resolvedSignalKinds: resolved,
    newSignalKinds: introduced,
    persistentSignalKinds: persistent,
    netSignalDelta: resolved.length - introduced.length,
    tokenDelta
  };
}

function round(n: number): number {
  return Number(n.toFixed(4));
}
