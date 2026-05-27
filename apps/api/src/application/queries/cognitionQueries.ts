import type { CognitionGraph, NodeLineage } from "../../domain/cognition.js";
import type {
  BranchRegistry,
  CognitionRepository,
  FailureSignalStore,
  LineageStore
} from "../../domain/cognitionPorts.js";
import type { BranchPointer } from "../../domain/replay.js";
import type { FailureSignal } from "../../domain/failure.js";

export interface CognitionGraphView {
  graph: CognitionGraph;
  lineage: NodeLineage[];
  branches: BranchPointer[];
  failureSignals: FailureSignal[];
  /** Aggregate uncertainty over all completed nodes. */
  uncertainty: {
    overall: number;
    variance: number;
    lowConfidenceTokens: number;
    nodeCount: number;
  };
}

export interface CognitionListItem {
  id: string;
  executionId: string;
  agentId: string;
  phase: string;
  startedAt: string;
  completedAt?: string;
  nodeCount: number;
  parentCognitionId?: string;
  hasFailureSignals: boolean;
}

export class CognitionQueries {
  constructor(
    private readonly cognitions: CognitionRepository,
    private readonly lineage: LineageStore,
    private readonly branches: BranchRegistry,
    private readonly failures: FailureSignalStore
  ) {}

  async listRecent(limit = 25): Promise<CognitionListItem[]> {
    const graphs = await this.cognitions.listRecent(limit);
    const enriched = await Promise.all(
      graphs.map(async (g) => {
        const signals = await this.failures.listByCognition(g.id);
        return {
          id: g.id,
          executionId: g.executionId,
          agentId: g.agentId,
          phase: g.phase,
          startedAt: g.startedAt,
          completedAt: g.completedAt,
          nodeCount: g.nodes.length,
          parentCognitionId: g.parentCognitionId,
          hasFailureSignals: signals.length > 0
        };
      })
    );
    return enriched;
  }

  async get(cognitionId: string): Promise<CognitionGraphView | undefined> {
    const graph = await this.cognitions.getById(cognitionId);
    if (!graph) return undefined;
    const [branches, failureSignals] = await Promise.all([
      this.branches.listForCognition(cognitionId),
      this.failures.listByCognition(cognitionId)
    ]);
    const lineage: NodeLineage[] = [];
    for (const node of graph.nodes) {
      const entry = await this.lineage.getLineage(node.id);
      if (entry) lineage.push(entry);
    }
    const completed = graph.nodes.filter((n) => n.status === "COMPLETED" && n.uncertainty);
    const overall = avg(completed.map((n) => n.uncertainty!.overall));
    const variance = avg(completed.map((n) => n.uncertainty!.variance));
    const lowConfidenceTokens = completed.reduce((acc, n) => acc + (n.uncertainty?.lowConfidenceTokens ?? 0), 0);

    return {
      graph,
      lineage,
      branches,
      failureSignals,
      uncertainty: {
        overall: Number(overall.toFixed(3)),
        variance: Number(variance.toFixed(4)),
        lowConfidenceTokens,
        nodeCount: completed.length
      }
    };
  }

  async lineageFor(nodeId: string): Promise<NodeLineage | undefined> {
    return this.lineage.getLineage(nodeId);
  }

  async family(nodeId: string): Promise<NodeLineage[]> {
    return this.lineage.listFamily(nodeId);
  }
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
