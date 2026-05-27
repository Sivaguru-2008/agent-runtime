import type { CognitionGraph, CognitionNode, NodeLineage } from "../../domain/cognition.js";
import type {
  BranchRegistry,
  CognitionRepository,
  FailureSignalStore,
  LineageStore,
  ReplayCertificationStore,
  ReplaySessionStore,
  SnapshotListOptions,
  SnapshotStore
} from "../../domain/cognitionPorts.js";
import type { BranchPointer, ReplayCertification, ReplaySession, ReplaySnapshot } from "../../domain/replay.js";
import {
  SnapshotCorruptionError,
  stampIntegrityHash,
  verifySnapshotIntegrity
} from "../../runtime/replay/snapshotIntegrity.js";
import type { SnapshotIntegrityViolationReporter } from "../../domain/cognitionPorts.js";
import type { FailureSeverity, FailureSignal } from "../../domain/failure.js";
import type {
  AnomalyDimension,
  ExecutionHealthSnapshot,
  HealthSnapshotStore
} from "../../domain/executionHealth.js";
import type {
  AnomalyIndex,
  AnomalyIndexEntry,
  AnomalyIndexQuery,
  FailureCluster,
  FailureSignature,
  FailureSignatureStore,
  ReplayOutcome,
  ReplayOutcomeStore
} from "../../domain/failureLearning.js";
import { deriveSignaturePayload } from "../../domain/signatureHashing.js";

export class InMemoryCognitionRepository implements CognitionRepository {
  private readonly graphs = new Map<string, CognitionGraph>();
  private readonly byExecution = new Map<string, string>();
  private readonly byParent = new Map<string, Set<string>>();

  async save(graph: CognitionGraph): Promise<void> {
    this.graphs.set(graph.id, { ...graph, nodes: [...graph.nodes], handoffs: [...graph.handoffs] });
    this.byExecution.set(graph.executionId, graph.id);
    if (graph.parentCognitionId) {
      const set = this.byParent.get(graph.parentCognitionId) ?? new Set<string>();
      set.add(graph.id);
      this.byParent.set(graph.parentCognitionId, set);
    }
  }

  async upsertNode(node: CognitionNode): Promise<void> {
    const graph = this.graphs.get(node.cognitionId);
    if (!graph) return;
    const idx = graph.nodes.findIndex((existing) => existing.id === node.id);
    if (idx >= 0) graph.nodes[idx] = node;
    else graph.nodes.push(node);
  }

  async getById(id: string): Promise<CognitionGraph | undefined> {
    const graph = this.graphs.get(id);
    return graph ? cloneGraph(graph) : undefined;
  }

  async getByExecution(executionId: string): Promise<CognitionGraph | undefined> {
    const id = this.byExecution.get(executionId);
    return id ? this.getById(id) : undefined;
  }

  async listRecent(limit: number): Promise<CognitionGraph[]> {
    return Array.from(this.graphs.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map(cloneGraph);
  }

  async listChildren(parentCognitionId: string): Promise<CognitionGraph[]> {
    const ids = this.byParent.get(parentCognitionId) ?? new Set<string>();
    return Array.from(ids)
      .map((id) => this.graphs.get(id))
      .filter((g): g is CognitionGraph => Boolean(g))
      .map(cloneGraph);
  }
}

function cloneGraph(graph: CognitionGraph): CognitionGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node })),
    handoffs: graph.handoffs.map((handoff) => ({ ...handoff }))
  };
}

export class InMemoryLineageStore implements LineageStore {
  private readonly map = new Map<string, NodeLineage>();

  private ensure(nodeId: string, cognitionId = ""): NodeLineage {
    let lineage = this.map.get(nodeId);
    if (!lineage) {
      lineage = { nodeId, cognitionId, ancestors: [], descendants: [], siblings: [] };
      this.map.set(nodeId, lineage);
    }
    return lineage;
  }

  async recordParent(child: string, parent: string): Promise<void> {
    const childLineage = this.ensure(child);
    const parentLineage = this.ensure(parent);
    if (!childLineage.ancestors.includes(parent)) childLineage.ancestors.push(parent);
    if (!parentLineage.descendants.includes(child)) parentLineage.descendants.push(child);
  }

  async recordSibling(a: string, b: string): Promise<void> {
    const aL = this.ensure(a);
    const bL = this.ensure(b);
    if (!aL.siblings.includes(b)) aL.siblings.push(b);
    if (!bL.siblings.includes(a)) bL.siblings.push(a);
  }

  async getLineage(nodeId: string): Promise<NodeLineage | undefined> {
    const lineage = this.map.get(nodeId);
    return lineage ? { ...lineage } : undefined;
  }

  async listFamily(rootNodeId: string): Promise<NodeLineage[]> {
    const result: NodeLineage[] = [];
    const queue = [rootNodeId];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const lineage = this.map.get(id);
      if (!lineage) continue;
      result.push({ ...lineage });
      queue.push(...lineage.descendants, ...lineage.siblings);
    }
    return result;
  }
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, ReplaySnapshot>();
  private readonly byCognition = new Map<string, Set<string>>();
  private reporter: SnapshotIntegrityViolationReporter | undefined;

  setIntegrityViolationReporter(reporter: SnapshotIntegrityViolationReporter): void {
    this.reporter = reporter;
  }

  async put(snapshot: ReplaySnapshot): Promise<void> {
    // Always (re)stamp on put so the persisted hash reflects the persisted
    // graph, no matter what the caller passed in. Trusting a caller-supplied
    // hash would defeat the validation invariant.
    const stamped = stampIntegrityHash(snapshot);
    this.snapshots.set(stamped.id, stamped);
    const set = this.byCognition.get(stamped.cognitionId) ?? new Set<string>();
    set.add(stamped.id);
    this.byCognition.set(stamped.cognitionId, set);
  }

  async get(snapshotId: string): Promise<ReplaySnapshot | undefined> {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) return undefined;
    this.assertIntegrity(snap, "get");
    return snap;
  }

  async listByCognition(
    cognitionId: string,
    options?: SnapshotListOptions
  ): Promise<ReplaySnapshot[]> {
    const ids = this.byCognition.get(cognitionId) ?? new Set<string>();
    const sorted = Array.from(ids)
      .map((id) => this.snapshots.get(id))
      .filter((s): s is ReplaySnapshot => Boolean(s))
      .sort((a, b) => a.frameIndex - b.frameIndex);

    // Task A2: every snapshot returned by listByCognition must be
    // integrity-verified by default. The only production caller is the
    // operator timeline view, which would otherwise render corrupted
    // history without surfacing it. The forensic bypass is opt-in and
    // still emits the SNAPSHOT_INTEGRITY_VIOLATED event via the reporter.
    if (options?.bypassIntegrityForForensics) {
      for (const snap of sorted) this.reportIfCorrupt(snap, "list");
      return sorted;
    }
    for (const snap of sorted) this.assertIntegrity(snap, "list");
    return sorted;
  }

  async nearest(cognitionId: string, frameIndex: number): Promise<ReplaySnapshot | undefined> {
    // Inline scan rather than calling listByCognition() so we do not pay
    // the cost of integrity-verifying every snapshot when the caller only
    // needs the nearest one.
    const ids = this.byCognition.get(cognitionId) ?? new Set<string>();
    const sorted = Array.from(ids)
      .map((id) => this.snapshots.get(id))
      .filter((s): s is ReplaySnapshot => Boolean(s))
      .sort((a, b) => a.frameIndex - b.frameIndex);
    let candidate: ReplaySnapshot | undefined;
    for (const snap of sorted) {
      if (snap.frameIndex <= frameIndex) candidate = snap;
      else break;
    }
    if (candidate) this.assertIntegrity(candidate, "nearest");
    return candidate;
  }

  /**
   * Test-only seam: inject a snapshot directly without re-stamping the hash.
   * Used by integrity tests to simulate post-write tampering (a row whose
   * graph was mutated after put() committed). Production code paths must
   * call put() so every persisted snapshot carries a verifiable hash.
   */
  injectRawForTest(snapshot: ReplaySnapshot): void {
    this.snapshots.set(snapshot.id, snapshot);
    const set = this.byCognition.get(snapshot.cognitionId) ?? new Set<string>();
    set.add(snapshot.id);
    this.byCognition.set(snapshot.cognitionId, set);
  }

  private assertIntegrity(snap: ReplaySnapshot, operation: "get" | "nearest" | "list"): void {
    const result = verifySnapshotIntegrity(snap);
    if (result.ok) return;
    // Fire-and-forget the reporter so a slow publish cannot delay the throw.
    try {
      this.reporter?.({
        snapshotId: snap.id,
        cognitionId: snap.cognitionId,
        executionId: snap.executionId,
        frameIndex: snap.frameIndex,
        storedHash: result.storedHash,
        computedHash: result.computedHash,
        operation
      });
    } catch {
      // Reporter failures are not allowed to mask the corruption throw.
    }
    throw new SnapshotCorruptionError(
      snap.id,
      snap.cognitionId,
      snap.executionId,
      snap.frameIndex,
      result.storedHash,
      result.computedHash
    );
  }

  /**
   * Task A2 — forensic-bypass surface: fire the integrity reporter on
   * mismatch but do not throw. Used only by listByCognition when
   * `bypassIntegrityForForensics` is set; UI rendering paths must NOT
   * call this directly. Even under bypass the bus event still fires so
   * dashboards reflect the corruption.
   */
  private reportIfCorrupt(snap: ReplaySnapshot, operation: "get" | "nearest" | "list"): void {
    const result = verifySnapshotIntegrity(snap);
    if (result.ok) return;
    try {
      this.reporter?.({
        snapshotId: snap.id,
        cognitionId: snap.cognitionId,
        executionId: snap.executionId,
        frameIndex: snap.frameIndex,
        storedHash: result.storedHash,
        computedHash: result.computedHash,
        operation
      });
    } catch {
      // swallow — forensic bypass is best-effort.
    }
  }
}

export class InMemoryReplaySessionStore implements ReplaySessionStore {
  private readonly sessions = new Map<string, ReplaySession>();

  async put(session: ReplaySession): Promise<void> {
    this.sessions.set(session.id, { ...session, frames: [...session.frames] });
    if (this.sessions.size > 100) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey !== undefined) {
        this.sessions.delete(oldestKey);
      }
    }
  }

  async get(sessionId: string): Promise<ReplaySession | undefined> {
    return this.sessions.get(sessionId);
  }

  async listByCognition(cognitionId: string): Promise<ReplaySession[]> {
    return Array.from(this.sessions.values()).filter((s) => s.cognitionId === cognitionId);
  }
}

export class InMemoryBranchRegistry implements BranchRegistry {
  private readonly branches: BranchPointer[] = [];

  async record(pointer: BranchPointer): Promise<void> {
    this.branches.push(pointer);
  }

  async listForCognition(cognitionId: string): Promise<BranchPointer[]> {
    return this.branches.filter(
      (b) => b.sourceCognitionId === cognitionId || b.branchCognitionId === cognitionId
    );
  }

  async listAll(): Promise<BranchPointer[]> {
    return [...this.branches];
  }
}

export class InMemoryFailureSignalStore implements FailureSignalStore {
  private readonly signals: FailureSignal[] = [];

  async record(signal: FailureSignal): Promise<void> {
    this.signals.push(signal);
  }

  async listByExecution(executionId: string): Promise<FailureSignal[]> {
    return this.signals.filter((s) => s.executionId === executionId);
  }

  async listByCognition(cognitionId: string): Promise<FailureSignal[]> {
    return this.signals.filter((s) => s.cognitionId === cognitionId);
  }

  async listRecent(limit: number): Promise<FailureSignal[]> {
    return [...this.signals]
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
      .slice(0, limit);
  }
}

// ─── Phase 7: Execution Health + Failure Learning stores ────────────────────

/**
 * Stores at most one snapshot per executionId — repeated put() overwrites,
 * matching the contract "snapshots always reflect the latest reading".
 *
 * `listMetricsForAgent` is a projection-style accessor: it returns only the
 * numeric dimensions, keeping baseline computation cheap (no graph deep-copy).
 */
export class InMemoryHealthSnapshotStore implements HealthSnapshotStore {
  private readonly snapshots = new Map<string, ExecutionHealthSnapshot>();

  async put(snapshot: ExecutionHealthSnapshot): Promise<void> {
    this.snapshots.set(snapshot.executionId, snapshot);
  }

  async get(executionId: string): Promise<ExecutionHealthSnapshot | undefined> {
    return this.snapshots.get(executionId);
  }

  async listRecent(limit: number): Promise<ExecutionHealthSnapshot[]> {
    return Array.from(this.snapshots.values())
      .sort((a, b) => b.computedAt.localeCompare(a.computedAt))
      .slice(0, limit);
  }

  async listByAgent(agentId: string, limit: number): Promise<ExecutionHealthSnapshot[]> {
    return Array.from(this.snapshots.values())
      .filter((s) => s.agentId === agentId)
      .sort((a, b) => b.computedAt.localeCompare(a.computedAt))
      .slice(0, limit);
  }

  async listMetricsForAgent(agentId: string, limit: number): Promise<
    Array<Pick<ExecutionHealthSnapshot, "executionId" | "computedAt"> & {
      dimensions: Record<AnomalyDimension, number>;
    }>
  > {
    const snapshots = await this.listByAgent(agentId, limit);
    return snapshots.map((s) => ({
      executionId: s.executionId,
      computedAt: s.computedAt,
      dimensions: {
        stepCount: s.anomaly.dimensions.stepCount?.observed ?? 0,
        nodeCount: s.anomaly.dimensions.nodeCount?.observed ?? 0,
        tokenTotal: s.anomaly.dimensions.tokenTotal?.observed ?? 0,
        durationMs: s.anomaly.dimensions.durationMs?.observed ?? 0,
        signalDensity: s.anomaly.dimensions.signalDensity?.observed ?? 0,
        toolCallCount: s.anomaly.dimensions.toolCallCount?.observed ?? 0
      }
    }));
  }
}

/**
 * Deterministic signature store. Identical signals always hash to the same
 * signatureId; the same signal recorded twice updates the counter and example
 * list rather than creating a duplicate cluster.
 *
 * Heat score: occurrencesInLast24h / max(1, totalOccurrences) gives a bounded
 * [0,1] freshness ratio. A signature with 100 lifetime occurrences but only 1
 * in the last 24h has heat 0.01; one with 5 of 5 in the last hour has heat 1.0.
 */
export class InMemoryFailureSignatureStore implements FailureSignatureStore {
  private readonly signatures = new Map<string, FailureSignature>();
  /** Per-signature timestamps of every observation — used for heat. */
  private readonly observationsAt = new Map<string, string[]>();

  async observe(signal: FailureSignal): Promise<FailureSignature> {
    const { id, role, summaryTemplate, metricKeys } = deriveSignaturePayload(signal);
    const now = signal.detectedAt;

    const existing = this.signatures.get(id);
    if (existing) {
      existing.lastSeenAt = now;
      existing.occurrenceCount += 1;
      existing.severityDistribution[signal.severity] =
        (existing.severityDistribution[signal.severity] ?? 0) + 1;
      // Keep at most 5 most-recent examples and 5 distinct exec IDs.
      existing.examples = [signal, ...existing.examples.filter((s) => s.id !== signal.id)].slice(0, 5);
      if (!existing.exampleExecutionIds.includes(signal.executionId)) {
        existing.exampleExecutionIds = [signal.executionId, ...existing.exampleExecutionIds].slice(0, 5);
      }
      this.recordObservation(id, now);
      return existing;
    }

    const severityDistribution: Record<FailureSeverity, number> = {
      INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0
    };
    severityDistribution[signal.severity] = 1;

    const signature: FailureSignature = {
      id,
      kind: signal.kind,
      role,
      summaryTemplate,
      metricKeys,
      firstSeenAt: now,
      lastSeenAt: now,
      occurrenceCount: 1,
      severityDistribution,
      examples: [signal],
      exampleExecutionIds: [signal.executionId]
    };
    this.signatures.set(id, signature);
    this.recordObservation(id, now);
    return signature;
  }

  async getById(signatureId: string): Promise<FailureSignature | undefined> {
    return this.signatures.get(signatureId);
  }

  async listClusters(limit: number): Promise<FailureCluster[]> {
    return Array.from(this.signatures.values())
      .map((sig) => this.toCluster(sig))
      .sort((a, b) => b.size - a.size)
      .slice(0, limit);
  }

  async listHot(minHeatScore: number, limit: number): Promise<FailureCluster[]> {
    return Array.from(this.signatures.values())
      .map((sig) => this.toCluster(sig))
      .filter((c) => c.heatScore >= minHeatScore)
      .sort((a, b) => b.heatScore - a.heatScore)
      .slice(0, limit);
  }

  private recordObservation(signatureId: string, at: string): void {
    const list = this.observationsAt.get(signatureId) ?? [];
    list.push(at);
    this.observationsAt.set(signatureId, list);
  }

  private toCluster(sig: FailureSignature): FailureCluster {
    const observations = this.observationsAt.get(sig.id) ?? [];
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const recent = observations.filter((iso) => Date.parse(iso) >= dayAgo).length;
    const heatScore = sig.occurrenceCount > 0 ? recent / sig.occurrenceCount : 0;
    const affectedExecutionCount = new Set(observations.map((_, i) =>
      sig.examples[i]?.executionId ?? sig.exampleExecutionIds[0]
    )).size || sig.exampleExecutionIds.length;
    return {
      signature: sig,
      size: sig.occurrenceCount,
      heatScore,
      affectedExecutionCount
    };
  }
}

/**
 * Linear-scan in-memory index. Good enough for tens of thousands of executions
 * in development and integration tests. Postgres-backed implementation can
 * replace this without changing callers.
 */
export class InMemoryAnomalyIndex implements AnomalyIndex {
  private readonly entries: AnomalyIndexEntry[] = [];

  async index(entry: AnomalyIndexEntry): Promise<void> {
    // Replace previous entry for the same execution to keep the index current.
    const idx = this.entries.findIndex((e) => e.executionId === entry.executionId);
    if (idx >= 0) this.entries[idx] = entry;
    else this.entries.push(entry);
  }

  async query(q: AnomalyIndexQuery): Promise<AnomalyIndexEntry[]> {
    let results = [...this.entries];
    if (q.minScore !== undefined) results = results.filter((e) => e.anomalyScore >= q.minScore!);
    if (q.dimension) results = results.filter((e) => e.topDimension === q.dimension);
    if (q.agentId) results = results.filter((e) => e.agentId === q.agentId);
    if (q.since) results = results.filter((e) => e.indexedAt >= q.since!);
    results.sort((a, b) => b.anomalyScore - a.anomalyScore);
    if (q.limit !== undefined) results = results.slice(0, q.limit);
    return results;
  }
}

export class InMemoryReplayOutcomeStore implements ReplayOutcomeStore {
  private readonly outcomes = new Map<string, ReplayOutcome>();

  async record(outcome: ReplayOutcome): Promise<void> {
    this.outcomes.set(outcome.executionId, outcome);
  }

  async getByExecution(executionId: string): Promise<ReplayOutcome | undefined> {
    return this.outcomes.get(executionId);
  }

  async listBranchesOf(sourceCognitionId: string): Promise<ReplayOutcome[]> {
    return Array.from(this.outcomes.values())
      .filter((o) => o.kind === "BRANCH" && o.sourceCognitionId === sourceCognitionId);
  }

  async listAll(): Promise<ReplayOutcome[]> {
    return Array.from(this.outcomes.values());
  }
}

/**
 * In-memory replay certification store. Per-execution, append-only.
 *
 * Each put() pushes a new entry — we never overwrite. The chain of
 * certifications IS the audit trail; a divergence detector compares the
 * latest two (or scans backwards) to identify the moment determinism broke.
 */
export class InMemoryReplayCertificationStore implements ReplayCertificationStore {
  private readonly byExecution = new Map<string, ReplayCertification[]>();

  async put(certification: ReplayCertification): Promise<void> {
    const list = this.byExecution.get(certification.executionId) ?? [];
    list.push(certification);
    this.byExecution.set(certification.executionId, list);
  }

  async latest(executionId: string): Promise<ReplayCertification | undefined> {
    const list = this.byExecution.get(executionId);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  async listForExecution(executionId: string): Promise<ReplayCertification[]> {
    return [...(this.byExecution.get(executionId) ?? [])];
  }
}
