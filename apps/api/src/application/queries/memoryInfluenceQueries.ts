import type { CognitionRepository } from "../../domain/cognitionPorts.js";
import type { MemoryRepository } from "../../domain/ports.js";

export interface MemoryInfluenceCell {
  memoryId: string;
  nodeId: string;
  role: string;
  weight: number;
}

export interface MemoryInfluenceHeatmap {
  cognitionId: string;
  /** Sorted descending by aggregate weight. */
  memories: Array<{
    memoryId: string;
    aggregateWeight: number;
    nodeContribution: number;
    /** True if memory was the top contributor for any node. */
    isAnchor: boolean;
    contentPreview?: string;
  }>;
  /** Flat list of all (memory, node) cells with weights — drives the heatmap grid. */
  cells: MemoryInfluenceCell[];
  /** Distinct nodes in order; rows of the heatmap. */
  nodes: Array<{ nodeId: string; role: string; sequence: number }>;
}

export class MemoryInfluenceQueries {
  constructor(
    private readonly cognitions: CognitionRepository,
    private readonly memory: MemoryRepository
  ) {}

  async heatmap(cognitionId: string): Promise<MemoryInfluenceHeatmap | undefined> {
    const graph = await this.cognitions.getById(cognitionId);
    if (!graph) return undefined;
    const cells: MemoryInfluenceCell[] = [];
    const aggregate = new Map<string, { weight: number; nodes: Set<string>; anchor: boolean }>();
    const nodes: MemoryInfluenceHeatmap["nodes"] = [];

    for (const node of graph.nodes) {
      nodes.push({ nodeId: node.id, role: node.role, sequence: node.sequence });
      const influences = [...(node.memoryInfluence ?? [])].sort((a, b) => b.weight - a.weight);
      influences.forEach((inf, index) => {
        cells.push({ memoryId: inf.memoryId, nodeId: node.id, role: node.role, weight: inf.weight });
        const entry = aggregate.get(inf.memoryId) ?? { weight: 0, nodes: new Set<string>(), anchor: false };
        entry.weight += inf.weight;
        entry.nodes.add(node.id);
        if (index === 0) entry.anchor = true;
        aggregate.set(inf.memoryId, entry);
      });
    }

    const allMemories = await this.memory.listByAgent(graph.agentId);
    const previewById = new Map(allMemories.map((m) => [m.id, m.content.slice(0, 120)]));

    const memories = Array.from(aggregate.entries())
      .map(([memoryId, entry]) => ({
        memoryId,
        aggregateWeight: Number(entry.weight.toFixed(2)),
        nodeContribution: entry.nodes.size,
        isAnchor: entry.anchor,
        contentPreview: previewById.get(memoryId)
      }))
      .sort((a, b) => b.aggregateWeight - a.aggregateWeight);

    return { cognitionId, memories, cells, nodes };
  }
}
