import type { CognitionGraph, CognitionNode } from "../../domain/cognition.js";
import type { DomainEvent } from "../../domain/events.js";
import type { CausalChain, CausalLink, FailureSignal } from "../../domain/failure.js";
import type { ReplayFrame } from "../../domain/replay.js";
import type { CognitionRepository } from "../../domain/cognitionPorts.js";
import type { EventStore } from "../../domain/ports.js";
import { toIso } from "../../shared/clock.js";
import type { Clock } from "../../shared/clock.js";

/**
 * Causality Tracer — Phase 3 replay product module.
 *
 * Given a FailureSignal, traces backward through the execution graph to find
 * the root cause chain: the sequence of events and decisions that made the
 * failure inevitable. This is the "why did this happen" answer that turns a
 * signal from an alert into an actionable debug target.
 *
 * OUTPUT:
 *   A CausalChain with an ordered list of CausalLinks from root cause to
 *   terminal failure, plus a frame index pointing operators to the right
 *   place in the replay timeline to start debugging.
 *
 * ALGORITHM:
 *   1. Locate the failing node (from signal.nodeId)
 *   2. Walk parent chain (via parentNodeId) up to the root
 *   3. For each ancestor, classify its causal role:
 *      ROOT_CAUSE   — first node with evidence of the failure mode
 *      PROPAGATION  — intermediate node that passed along bad state
 *      TERMINAL     — the node where the failure actually manifested
 *   4. Supplement the ancestor chain with event-level evidence
 *      (e.g., for TOOL_MISUSE: the first TOOL_CALLED event with empty input)
 *   5. Identify the replay frame index of the root cause for scrubber positioning
 */
export class CausalityTracer {
  constructor(
    private readonly cognitions: CognitionRepository,
    private readonly events: EventStore,
    private readonly clock: Clock
  ) {}

  async trace(signal: FailureSignal, frames: ReplayFrame[]): Promise<CausalChain> {
    const graph = signal.cognitionId
      ? await this.cognitions.getById(signal.cognitionId)
      : await this.cognitions.getByExecution(signal.executionId);

    const executionEvents = await this.events.listByExecution(signal.executionId);

    const links: CausalLink[] = [];
    let rootCauseFrameIndex: number | undefined;
    let rootCauseDescription = "Unknown root cause";

    if (graph && signal.nodeId) {
      const nodeMap = new Map<string, CognitionNode>(graph.nodes.map((n) => [n.id, n]));
      const terminalNode = nodeMap.get(signal.nodeId);

      if (terminalNode) {
        // Walk the parent chain from terminal node to root.
        const ancestorChain = buildAncestorChain(terminalNode, nodeMap);

        // Classify each ancestor's causal role.
        for (let i = 0; i < ancestorChain.length; i++) {
          const node = ancestorChain[i];
          const isLast = i === ancestorChain.length - 1;
          const isFirst = i === 0;

          const causalRole: CausalLink["causalRole"] = isFirst
            ? "TERMINAL"
            : isLast
              ? "ROOT_CAUSE"
              : "PROPAGATION";

          links.push({
            nodeId: node.id,
            role: node.role,
            causalRole,
            description: describeNode(node, signal.kind, executionEvents)
          });
        }

        // Find the root cause frame in the replay timeline.
        const rootNode = ancestorChain[ancestorChain.length - 1];
        if (rootNode) {
          rootCauseFrameIndex = findFrameForNode(rootNode.id, frames, executionEvents);
          rootCauseDescription = buildRootCauseDescription(signal, rootNode, executionEvents);
        }
      }
    }

    // If we couldn't trace via node ancestry, fall back to event-level tracing.
    if (links.length === 0) {
      const eventLinks = traceFromEvents(signal, executionEvents, frames);
      links.push(...eventLinks.links);
      rootCauseFrameIndex = eventLinks.rootCauseFrameIndex;
      rootCauseDescription = eventLinks.description;
    }

    // Reverse so index-0 is ROOT_CAUSE, last is TERMINAL.
    links.reverse();

    return {
      signalId: signal.id,
      cognitionId: signal.cognitionId,
      executionId: signal.executionId,
      links,
      rootCauseDescription,
      rootCauseFrameIndex,
      tracedAt: toIso(this.clock.now())
    };
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function buildAncestorChain(
  startNode: CognitionNode,
  nodeMap: Map<string, CognitionNode>
): CognitionNode[] {
  const chain: CognitionNode[] = [startNode];
  let current = startNode;
  const visited = new Set<string>([startNode.id]);

  while (current.parentNodeId) {
    const parent = nodeMap.get(current.parentNodeId);
    if (!parent || visited.has(parent.id)) break;
    chain.push(parent);
    visited.add(parent.id);
    current = parent;
  }

  return chain;  // [terminal, ..., root]
}

function describeNode(
  node: CognitionNode,
  signalKind: string,
  events: DomainEvent[]
): string {
  const base = `${node.role} (seq ${node.sequence}, status: ${node.status})`;

  // Enrich description based on signal kind.
  switch (signalKind) {
    case "HALLUCINATION": {
      const uncertainty = node.uncertainty?.overall ?? 0;
      const memCount = node.memoryInfluence?.length ?? 0;
      return `${base} — uncertainty ${(uncertainty * 100).toFixed(0)}%, ${memCount} memories consulted`;
    }
    case "CONTRADICTION": {
      const keys = Object.keys(node.output ?? {}).slice(0, 5).join(", ");
      return `${base} — output keys: [${keys}]`;
    }
    case "RECURSION":
    case "EXECUTION_LOOP": {
      return `${base} — inputFingerprint: ${node.inputFingerprint.slice(0, 12)}`;
    }
    case "TOOL_MISUSE": {
      const toolEvents = events.filter((e) => e.type === "TOOL_CALLED");
      const relatedTool = toolEvents.find(
        (e) => (e.payload as { nodeId?: string }).nodeId === node.id
      );
      const toolName = (relatedTool?.payload as { toolCall?: { toolName?: string } })?.toolCall?.toolName;
      return `${base}${toolName ? ` — tool: "${toolName}"` : ""}`;
    }
    default:
      return base;
  }
}

function findFrameForNode(
  nodeId: string,
  frames: ReplayFrame[],
  events: DomainEvent[]
): number | undefined {
  // Find an event that references this nodeId, then find its frame.
  const matchingEvent = events.find((e) => {
    const p = e.payload as Record<string, unknown>;
    const node = p.node as { id?: string } | undefined;
    return node?.id === nodeId;
  });
  if (!matchingEvent) return undefined;

  const matchingFrame = frames.find((f) => f.eventSequence === (matchingEvent.sequence ?? 0));
  return matchingFrame?.index;
}

function buildRootCauseDescription(
  signal: FailureSignal,
  rootNode: CognitionNode,
  events: DomainEvent[]
): string {
  switch (signal.kind) {
    case "HALLUCINATION":
      return `${rootNode.role} produced output without memory grounding (uncertainty: ${((rootNode.uncertainty?.overall ?? 0) * 100).toFixed(0)}%)`;
    case "CONTRADICTION":
      return `${rootNode.role} established state that later nodes contradicted`;
    case "RECURSION":
      return `${rootNode.role} re-entered the same input state — cognition stuck in loop`;
    case "EXECUTION_LOOP":
      return `Execution entered retry loop at sequence ${rootNode.sequence} without progress`;
    case "TOOL_MISUSE": {
      const failedTool = events
        .filter((e) => e.type === "TOOL_CALLED")
        .find((e) => (e.payload as { toolCall?: { error?: string } }).toolCall?.error);
      const toolName = (failedTool?.payload as { toolCall?: { toolName?: string } })?.toolCall?.toolName;
      return toolName
        ? `Tool "${toolName}" failure originated from ${rootNode.role}`
        : `Tool failure originated from ${rootNode.role}`;
    }
    case "CORRUPTED_MEMORY":
      return `Memory corruption propagated through ${rootNode.role} into downstream nodes`;
    default:
      return `Failure originated at ${rootNode.role} (seq ${rootNode.sequence})`;
  }
}

function traceFromEvents(
  signal: FailureSignal,
  events: DomainEvent[],
  frames: ReplayFrame[]
): { links: CausalLink[]; rootCauseFrameIndex?: number; description: string } {
  // Event-level fallback when we have no cognition graph.
  // Find the earliest relevant event sequence from the signal evidence.
  const evidenceSeqs = signal.evidence
    .filter((e) => e.eventSequence !== undefined)
    .map((e) => e.eventSequence!)
    .sort((a, b) => a - b);

  if (evidenceSeqs.length === 0) {
    return {
      links: [{
        causalRole: "ROOT_CAUSE",
        description: `${signal.kind} detected — no causal chain available without cognition graph`
      }],
      description: signal.summary
    };
  }

  const rootSeq = evidenceSeqs[0];
  const rootEvent = events.find((e) => (e.sequence ?? 0) === rootSeq);
  const rootFrame = frames.find((f) => f.eventSequence === rootSeq);

  const links: CausalLink[] = [
    {
      eventSequence: rootSeq,
      causalRole: "ROOT_CAUSE",
      description: `${rootEvent?.type ?? "Event"} at sequence ${rootSeq} — earliest evidence of failure`
    }
  ];

  for (let i = 1; i < evidenceSeqs.length; i++) {
    const seq = evidenceSeqs[i];
    const evt = events.find((e) => (e.sequence ?? 0) === seq);
    links.push({
      eventSequence: seq,
      causalRole: i === evidenceSeqs.length - 1 ? "TERMINAL" : "PROPAGATION",
      description: `${evt?.type ?? "Event"} at sequence ${seq}`
    });
  }

  return {
    links,
    rootCauseFrameIndex: rootFrame?.index,
    description: signal.summary
  };
}
