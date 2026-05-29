import type { DomainEvent } from "../../domain/events.js";

/**
 * Derive the set of (executionId, link_kind) and cognitionId rows that should
 * be inserted into `event_execution_links` / `event_cognition_links` for a
 * given event.
 *
 * Centralizing this in one pure function means the in-memory store and the
 * Postgres store always agree on what an event is linked to — replay and
 * snapshot queries stay consistent across drivers.
 *
 * Link kinds:
 *   AGGREGATE  — event.aggregateType=EXECUTION and aggregateId is the exec
 *   EXECUTION  — payload references an executionId directly
 *   COGNITION  — event is a cognition node/handoff event; the execution comes
 *                from payload.node.executionId or payload.graph.executionId
 *   BRANCH     — a REPLAY_BRANCH_CREATED pointer (linked to source execution)
 *   CHECKPOINT — payload.checkpoint.executionId
 *   LEASE      — payload.lease.executionId
 *   RESUME     — EXECUTION_RESUMED payload.executionId
 */
export interface EventExecutionLink {
  executionId: string;
  kind: "AGGREGATE" | "EXECUTION" | "COGNITION" | "BRANCH" | "CHECKPOINT" | "LEASE" | "RESUME";
}

export function deriveEventLinks(event: DomainEvent): {
  executions: EventExecutionLink[];
  cognitions: string[];
} {
  const executions = new Map<string, EventExecutionLink["kind"]>();
  const cognitions = new Set<string>();

  const add = (executionId: unknown, kind: EventExecutionLink["kind"]): void => {
    if (typeof executionId !== "string" || !executionId) return;
    // Stronger kind wins (AGGREGATE > EXECUTION > others) so the same exec id
    // is not duplicated with a weaker classification.
    const existing = executions.get(executionId);
    if (!existing || rankKind(kind) > rankKind(existing)) {
      executions.set(executionId, kind);
    }
  };

  const addCognition = (id: unknown): void => {
    if (typeof id === "string" && id) cognitions.add(id);
  };

  if (event.aggregateType === "EXECUTION") {
    add(event.aggregateId, "AGGREGATE");
  }

  const payload = event.payload as Record<string, unknown>;

  add(readPath(payload, ["execution", "id"]), "EXECUTION");
  add(readPath(payload, ["step", "executionId"]), "EXECUTION");
  add(readPath(payload, ["toolCall", "executionId"]), "EXECUTION");
  add(readPath(payload, ["replayExecutionId"]), "EXECUTION");
  // Do not link parentExecutionId — child replay/lifecycle events must not
  // appear in the parent's execution log (breaks replay watermark semantics).
  add(readPath(payload, ["executionId"]), "RESUME");

  // Cognition node / graph events carry an executionId nested under the node
  // or graph object.
  add(readPath(payload, ["node", "executionId"]), "COGNITION");
  add(readPath(payload, ["graph", "executionId"]), "COGNITION");
  add(readPath(payload, ["snapshot", "executionId"]), "COGNITION");

  // Branch pointer: link to the source execution so replay diffs can pull
  // both sides without scanning.
  const branchSource = readPath(payload, ["pointer", "sourceCognitionId"]);
  if (typeof branchSource === "string" && branchSource) {
    cognitions.add(branchSource);
  }
  const branchTarget = readPath(payload, ["pointer", "branchCognitionId"]);
  if (typeof branchTarget === "string" && branchTarget) {
    cognitions.add(branchTarget);
  }

  // Cluster events
  add(readPath(payload, ["lease", "executionId"]), "LEASE");
  add(readPath(payload, ["checkpoint", "executionId"]), "CHECKPOINT");

  // Cognition linkage
  addCognition(payload.cognitionId);
  addCognition(readPath(payload, ["node", "cognitionId"]));
  addCognition(readPath(payload, ["graph", "id"]));
  addCognition(readPath(payload, ["snapshot", "cognitionId"]));
  addCognition(readPath(payload, ["signal", "cognitionId"]));

  return {
    executions: Array.from(executions.entries()).map(([executionId, kind]) => ({ executionId, kind })),
    cognitions: Array.from(cognitions)
  };
}

function rankKind(kind: EventExecutionLink["kind"]): number {
  switch (kind) {
    case "AGGREGATE":
      return 6;
    case "EXECUTION":
      return 5;
    case "COGNITION":
      return 4;
    case "RESUME":
      return 3;
    case "BRANCH":
      return 2;
    case "LEASE":
      return 1;
    case "CHECKPOINT":
      return 0;
  }
}

function readPath(source: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}
