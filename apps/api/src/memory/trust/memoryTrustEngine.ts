import type { MemoryRecord, MemoryType } from "../../domain/model.js";
import type { CognitionGraph, MemoryInfluence } from "../../domain/cognition.js";

export interface MemoryTrustScore {
  recency: number; // 0..1 freshness
  frequency: number; // 0..1 retrieval frequency
  sourceReliability: number; // 0..1 source trust
  contradictionLikelihood: number; // 0..1 conflict probability
  semanticRelevance: number; // 0..1 query relevance
  executionSuccessCorrelation: number; // 0..1 historical execution success correlation
  overall: number; // Aggregated score 0..1
}

export interface ContaminationAlert {
  id: string;
  memoryId: string;
  type: "SEMANTIC_CONFLICT" | "OUTDATED_INSTRUCTION" | "RECURSIVE_CONTAMINATION_LOOP";
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  message: string;
  conflictingMemoryIds?: string[];
}

export interface ScoredMemory {
  memory: MemoryRecord;
  trustScore: MemoryTrustScore;
  freshnessScore: number;
  isStale: boolean;
  isSuppressed: boolean;
  contaminationAlerts: ContaminationAlert[];
  lineage: {
    dependencies: string[]; // MemoryIds this memory depends on
    derivedFromExecutionId?: string;
  };
}

export interface TrustEngineOptions {
  halfLifeHours?: number;
  staleThreshold?: number;
  suppressStale?: boolean;
  minTrustThreshold?: number;
}

export class MemoryTrustEngine {
  private readonly halfLifeMs: number;
  private readonly staleThreshold: number;
  private readonly suppressStale: boolean;
  private readonly minTrustThreshold: number;

  // In-memory frequency tracker to track retrievals across runtime executions
  private readonly retrievalCounts = new Map<string, number>();

  // In-memory memory dependency graph: childMemoryId -> set of parentMemoryIds
  private readonly dependencyGraph = new Map<string, Set<string>>();

  // Track which memories were retrieved by which execution
  private readonly executionRetrievals = new Map<string, string[]>();

  constructor(options: TrustEngineOptions = {}) {
    const halfLifeHours = options.halfLifeHours ?? 24;
    this.halfLifeMs = halfLifeHours * 60 * 60 * 1000;
    this.staleThreshold = options.staleThreshold ?? 0.25;
    this.suppressStale = options.suppressStale ?? true;
    this.minTrustThreshold = options.minTrustThreshold ?? 0.35;
  }

  /**
   * Track memories retrieved by a specific execution.
   */
  trackExecutionRetrieval(executionId: string, memoryIds: string[]): void {
    this.executionRetrievals.set(executionId, memoryIds);
  }

  /**
   * Link a newly created memory to the memories that were retrieved in the same execution context.
   */
  linkNewMemory(memoryId: string, executionId?: string): void {
    if (!executionId) return;
    const retrieved = this.executionRetrievals.get(executionId);
    if (retrieved && retrieved.length > 0) {
      this.recordDependency(memoryId, retrieved);
    }
  }

  /**
   * Track retrieval frequency for given memories.
   */
  trackRetrievals(memoryIds: string[]): void {
    for (const id of memoryIds) {
      const count = this.retrievalCounts.get(id) ?? 0;
      this.retrievalCounts.set(id, count + 1);
    }
  }

  /**
   * Record memory dependency edges (e.g. Memory A was created during an execution that read Memory B).
   */
  recordDependency(childMemoryId: string, parentMemoryIds: string[]): void {
    const parents = this.dependencyGraph.get(childMemoryId) ?? new Set<string>();
    for (const pId of parentMemoryIds) {
      parents.add(pId);
    }
    this.dependencyGraph.set(childMemoryId, parents);
  }

  /**
   * Get the dependency map for a set of memory IDs.
   */
  getDependencyMap(memoryIds: string[]): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const id of memoryIds) {
      const parents = this.dependencyGraph.get(id);
      if (parents) {
        map[id] = Array.from(parents);
      } else {
        map[id] = [];
      }
    }
    return map;
  }

  /**
   * Core scoring, decay, loop-detection, and filtering function.
   * Processes retrieved memories, computes multi-dimensional scores, flags alerts, and filters out noise.
   */
  scoreAndFilter(
    memories: MemoryRecord[],
    query: string,
    context: {
      executionStatusMap?: Map<string, "COMPLETED" | "FAILED" | "RUNNING">;
      cognitionHistory?: CognitionGraph[];
    } = {}
  ): ScoredMemory[] {
    const now = Date.now();
    const scored: ScoredMemory[] = [];
    const executionStatusMap = context.executionStatusMap ?? new Map<string, "COMPLETED" | "FAILED" | "RUNNING" >();

    // 1. Calculate basic scoring dimensions for each memory
    for (const mem of memories) {
      // Recency / Freshness
      const freshness = this.calculateFreshness(mem, now);
      const isStale = freshness < this.staleThreshold;

      // Frequency Score
      const hits = this.retrievalCounts.get(mem.id) ?? 0;
      // Logarithmic scaling so frequent hits don't grow bounds linearly
      const frequency = hits > 0 ? Math.min(1.0, Math.log1p(hits) / 3) : 0.2;

      // Reliability Score
      const sourceReliability = this.calculateSourceReliability(mem);

      // Execution Success Correlation
      let successScore = 0.8;
      if (mem.executionId) {
        const status = executionStatusMap.get(mem.executionId);
        if (status === "COMPLETED") {
          successScore = 0.95;
        } else if (status === "FAILED") {
          successScore = 0.15;
        }
      }

      // Semantic Relevance Score (lexical overlap placeholder / basic similarity)
      const semanticRelevance = this.calculateSemanticRelevance(mem.content, query);

      // Initialize scored item (contradiction likelihood and overall trust computed in step 2)
      scored.push({
        memory: mem,
        trustScore: {
          recency: freshness,
          frequency,
          sourceReliability,
          contradictionLikelihood: 0,
          semanticRelevance,
          executionSuccessCorrelation: successScore,
          overall: 0
        },
        freshnessScore: freshness,
        isStale,
        isSuppressed: false,
        contaminationAlerts: [],
        lineage: {
          dependencies: Array.from(this.dependencyGraph.get(mem.id) ?? []),
          derivedFromExecutionId: mem.executionId
        }
      });
    }

    // 2. Perform contradiction detection, outdated instruction checks, and recursive loops
    for (let i = 0; i < scored.length; i++) {
      const item = scored[i];
      const mem = item.memory;
      const alerts: ContaminationAlert[] = [];

      // A. Negation Semantic Contradiction Check
      const conflictingIds: string[] = [];
      for (let j = 0; j < scored.length; j++) {
        if (i === j) continue;
        const other = scored[j];
        if (this.detectNegationConflict(mem.content, other.memory.content)) {
          conflictingIds.push(other.memory.id);
        }
      }

      if (conflictingIds.length > 0) {
        alerts.push({
          id: `conflict-${mem.id}`,
          memoryId: mem.id,
          type: "SEMANTIC_CONFLICT",
          severity: "HIGH",
          message: `Memory semantically conflicts with ${conflictingIds.length} other retrieved memory(s).`,
          conflictingMemoryIds: conflictingIds
        });
        item.trustScore.contradictionLikelihood = 0.85;
      }

      // B. Outdated Instruction Check
      // If a newer memory exists with highly similar instruction text but updated parameters, mark old one outdated.
      const supercedingIds: string[] = [];
      for (let j = 0; j < scored.length; j++) {
        if (i === j) continue;
        const other = scored[j];
        if (
          other.memory.createdAt > mem.createdAt &&
          this.isInstructionUpdate(mem.content, other.memory.content)
        ) {
          supercedingIds.push(other.memory.id);
        }
      }

      if (supercedingIds.length > 0) {
        alerts.push({
          id: `outdated-${mem.id}`,
          memoryId: mem.id,
          type: "OUTDATED_INSTRUCTION",
          severity: "MEDIUM",
          message: `Memory instruction is superseded by a newer retrieval: ${supercedingIds.join(", ")}`,
          conflictingMemoryIds: supercedingIds
        });
        // Outdated Instructions significantly lower freshness/recency and success trust
        item.trustScore.recency *= 0.3;
      }

      // C. Recursive Contamination Loop Check
      const loopPath = this.findContaminationLoop(mem.id);
      if (loopPath) {
        alerts.push({
          id: `loop-${mem.id}`,
          memoryId: mem.id,
          type: "RECURSIVE_CONTAMINATION_LOOP",
          severity: "CRITICAL",
          message: `Recursive contamination loop detected: ${loopPath.join(" -> ")}`,
          conflictingMemoryIds: loopPath.filter(id => id !== mem.id)
        });
        item.trustScore.sourceReliability *= 0.1; // extreme reliability penalty
      }

      item.contaminationAlerts = alerts;

      // D. Compute Overall Trust Score
      // Weights: Relevance (30%), Success (25%), Freshness (20%), Reliability (15%), Frequency (10%)
      // Then multiply by (1 - ContradictionLikelihood)
      let overall =
        item.trustScore.semanticRelevance * 0.30 +
        item.trustScore.executionSuccessCorrelation * 0.25 +
        item.trustScore.recency * 0.20 +
        item.trustScore.sourceReliability * 0.15 +
        item.trustScore.frequency * 0.10;

      // Penalize heavily based on contradiction
      overall *= (1.0 - item.trustScore.contradictionLikelihood);

      // Clamp overall trust score
      item.trustScore.overall = Number(Math.min(1.0, Math.max(0.01, overall)).toFixed(2));

      // E. Stale Memory Suppression & Low-Trust Filtering
      const hasCriticalAlert = alerts.some(a => a.severity === "CRITICAL");
      const isLowTrust = item.trustScore.overall < this.minTrustThreshold;

      if (hasCriticalAlert || isLowTrust || (item.isStale && this.suppressStale)) {
        item.isSuppressed = true;
      }
    }

    return scored;
  }

  /**
   * Helper: Calculate exponential decay freshness
   */
  private calculateFreshness(memory: MemoryRecord, now: number): number {
    if (memory.type === "SEMANTIC_REFERENCE") {
      return 1.0; // permanent reference documents do not decay
    }
    const elapsed = Math.max(0, now - new Date(memory.createdAt).getTime());
    // Exponential decay freshness: e^(-lambda * t)
    const lambda = Math.LN2 / this.halfLifeMs;
    return Number(Math.exp(-lambda * elapsed).toFixed(4));
  }

  /**
   * Helper: Source reliability based on type
   */
  private calculateSourceReliability(memory: MemoryRecord): number {
    switch (memory.type) {
      case "SEMANTIC_REFERENCE":
        return 1.0;
      case "TASK_HISTORY":
        return 0.85;
      case "EPISODIC":
        return 0.9;
      default:
        return 0.7;
    }
  }

  /**
   * Helper: Calculate semantic relevance (coarse lexical/phrase Jaccard overlap)
   */
  private calculateSemanticRelevance(content: string, query: string): number {
    const qWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const cWords = new Set(content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    if (qWords.size === 0) return 0.5;

    let overlap = 0;
    for (const qw of qWords) {
      if (cWords.has(qw)) overlap++;
    }

    // Weighted overlap score
    return Number((overlap / qWords.size).toFixed(3));
  }

  /**
   * Helper: Detect direct negated contradictions between two strings
   */
  private detectNegationConflict(s1: string, s2: string): boolean {
    const clean1 = s1.toLowerCase();
    const clean2 = s2.toLowerCase();

    // Check for "enable X" vs "disable X" or "do X" vs "not do X"
    const negationKeywords = ["not", "never", "no ", "don't", "disable", "stop", "avoid"];

    // Find shared subject phrases or words
    const s1Words = clean1.split(/\s+/).filter(w => w.length > 4);
    const s2Words = clean2.split(/\s+/).filter(w => w.length > 4);
    const intersection = s1Words.filter(w => s2Words.includes(w));

    // If they share significant nouns/verbs, check if one contains a negation that the other lacks
    if (intersection.length >= 2) {
      const hasNeg1 = negationKeywords.some(kw => clean1.includes(kw));
      const hasNeg2 = negationKeywords.some(kw => clean2.includes(kw));
      if (hasNeg1 !== hasNeg2) {
        return true;
      }
    }
    return false;
  }

  /**
   * Helper: Check if one memory instruction updates or overrides another
   */
  private isInstructionUpdate(oldContent: string, newContent: string): boolean {
    const oLower = oldContent.toLowerCase();
    const nLower = newContent.toLowerCase();

    // Look for matching configure patterns like "use model x" vs "use model y"
    // or "brave search key is x" vs "brave search key is y"
    const configureKeywords = ["use", "set", "enable", "disable", "key", "config", "path"];
    const hasConfigWord = configureKeywords.some(kw => oLower.includes(kw) && nLower.includes(kw));

    if (hasConfigWord) {
      const oWords = oLower.split(/\s+/).filter(w => w.length > 4);
      const nWords = nLower.split(/\s+/).filter(w => w.length > 4);
      const sharedWords = oWords.filter(w => nWords.includes(w));

      // High structural overlap but not identical content implies update
      if (sharedWords.length >= 3 && oLower !== nLower) {
        return true;
      }
    }
    return false;
  }

  /**
   * Helper: Graph cycle detection to find recursive contamination loops
   */
  private findContaminationLoop(startId: string): string[] | null {
    const visited = new Set<string>();
    const stack: string[] = [];

    const dfs = (currId: string): string[] | null => {
      if (stack.includes(currId)) {
        // Loop detected! Return path starting from first occurrence
        const idx = stack.indexOf(currId);
        return [...stack.slice(idx), currId];
      }
      if (visited.has(currId)) {
        return null;
      }

      visited.add(currId);
      stack.push(currId);

      const parents = this.dependencyGraph.get(currId);
      if (parents) {
        for (const pId of parents) {
          const path = dfs(pId);
          if (path) return path;
        }
      }

      stack.pop();
      return null;
    };

    return dfs(startId);
  }
}
