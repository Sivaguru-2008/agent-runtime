/**
 * Seeded factories for integration tests.
 *
 * These produce realistic domain entities (events, cognition graphs, leases,
 * checkpoints) without going through the runtime, so tests can drive each
 * adapter directly and isolate which layer they are validating.
 *
 * Determinism: every factory takes an explicit seed so two test runs produce
 * bit-identical inputs (and therefore bit-identical fingerprints). The seed
 * threads through `deterministicId` so cognition/node/session/event IDs are
 * stable across runs — this is what makes the replay-determinism suite mean
 * anything.
 */
import { randomUUID } from "node:crypto";
import type { DomainEvent, DomainEventType } from "../../../src/domain/events.js";
import type { CognitionGraph, CognitionNode } from "../../../src/domain/cognition.js";
import type { ExecutionCheckpoint, ExecutionLease, RuntimeWorker } from "../../../src/domain/cluster.js";
import { deterministicId, syncFingerprint } from "../../../src/shared/determinism.js";
import { toIso } from "../../../src/shared/clock.js";

const FIXED_EPOCH = new Date("2026-01-01T00:00:00.000Z");

export interface EventFixtureInput {
  type: DomainEventType;
  executionId: string;
  cognitionId?: string;
  payloadExtras?: Record<string, unknown>;
  /** Logical step — used to derive a stable id + offset timestamp. */
  step: number;
  /** Seed group; events sharing the same group produce a stable lineage. */
  seed: string;
}

/**
 * Build a DomainEvent with no IO. Used to bypass the full event factory in
 * tests that need to assert append/lookup behavior on the store layer.
 */
export function makeEvent(input: EventFixtureInput): DomainEvent {
  const id = uuidFromHex(deterministicId([input.seed, input.type, input.step]));
  const ts = new Date(FIXED_EPOCH.getTime() + input.step * 1000);
  const payload: Record<string, unknown> = {
    executionId: input.executionId,
    ...(input.cognitionId ? { cognitionId: input.cognitionId } : {}),
    ...(input.payloadExtras ?? {})
  };
  return {
    id,
    type: input.type,
    aggregateId: input.executionId,
    aggregateType: "EXECUTION",
    version: 1,
    timestamp: toIso(ts),
    payload,
    metadata: {
      traceId: deterministicId([input.seed, "trace"]),
      correlationId: deterministicId([input.seed, "corr"]),
      schemaVersion: 1,
      source: "integration-test",
      idempotencyKey: deterministicId([input.seed, input.type, input.step, "idem"])
    }
  };
}

/**
 * Build a small, deterministic cognition graph: 4 nodes (PLAN → EXECUTE →
 * VERIFY → MEMORY_COMMIT). Sized for tests that need to verify lineage,
 * snapshot equivalence, and branch replay without dragging in the orchestrator.
 */
export function makeCognitionGraph(opts: {
  seed: string;
  agentId?: string;
  executionId?: string;
}): CognitionGraph {
  const cognitionId = deterministicId([opts.seed, "cognition"]);
  const executionId = opts.executionId ?? uuidFromHex(deterministicId([opts.seed, "execution"]));
  const agentId = opts.agentId ?? uuidFromHex(deterministicId([opts.seed, "agent"]));
  const baseTs = FIXED_EPOCH.getTime();
  const roles = ["PLANNER", "EXECUTOR", "VERIFIER", "MEMORY_MANAGER"] as const;
  const nodes: CognitionNode[] = roles.map((role, idx) => {
    const seq = idx;
    const input = { role, seq };
    return {
      id: deterministicId([cognitionId, seq, role, syncFingerprint(input)]),
      cognitionId,
      executionId,
      sequence: seq,
      role,
      phase: idx === 0 ? "PLAN" : idx === 1 ? "EXECUTE" : idx === 2 ? "VERIFY" : "MEMORY_COMMIT",
      status: "COMPLETED",
      inputFingerprint: syncFingerprint(input),
      input,
      output: { ok: true, role },
      startedAt: toIso(new Date(baseTs + seq * 1000)),
      completedAt: toIso(new Date(baseTs + seq * 1000 + 500)),
      durationMs: 500
    };
  });
  return {
    id: cognitionId,
    executionId,
    agentId,
    phase: "COMPLETE",
    startedAt: toIso(new Date(baseTs)),
    completedAt: toIso(new Date(baseTs + roles.length * 1000)),
    nodes,
    handoffs: [],
    output: { final: "ok" }
  };
}

/**
 * Build a deterministic event log that mirrors the lifecycle of a cognition:
 * EXECUTION_STARTED → COGNITION_STARTED → 4 × COGNITION_NODE_(STARTED|COMPLETED)
 * → COGNITION_COMPLETED → EXECUTION_COMPLETED. The frame builder turns this
 * into exactly 11 frames in a known order — what the determinism suite checks.
 */
export function makeCognitionEventLog(graph: CognitionGraph, seed: string): DomainEvent[] {
  const events: DomainEvent[] = [];
  let step = 0;
  events.push(makeEvent({
    type: "EXECUTION_STARTED",
    executionId: graph.executionId,
    seed, step: step++,
    payloadExtras: { execution: { id: graph.executionId, agentId: graph.agentId } }
  }));
  events.push(makeEvent({
    type: "COGNITION_STARTED",
    executionId: graph.executionId,
    cognitionId: graph.id,
    seed, step: step++,
    payloadExtras: { graph: { id: graph.id, executionId: graph.executionId } }
  }));
  for (const node of graph.nodes) {
    events.push(makeEvent({
      type: "COGNITION_NODE_STARTED",
      executionId: graph.executionId,
      cognitionId: graph.id,
      seed, step: step++,
      payloadExtras: { node: { ...node, status: "RUNNING" } }
    }));
    events.push(makeEvent({
      type: "COGNITION_NODE_COMPLETED",
      executionId: graph.executionId,
      cognitionId: graph.id,
      seed, step: step++,
      payloadExtras: { node }
    }));
  }
  events.push(makeEvent({
    type: "COGNITION_COMPLETED",
    executionId: graph.executionId,
    cognitionId: graph.id,
    seed, step: step++,
    payloadExtras: { graph: { id: graph.id, executionId: graph.executionId } }
  }));
  events.push(makeEvent({
    type: "EXECUTION_COMPLETED",
    executionId: graph.executionId,
    seed, step: step++,
    payloadExtras: { execution: { id: graph.executionId, agentId: graph.agentId } }
  }));
  return events;
}

export function makeWorker(opts: { id: string; capacity?: number; now?: Date }): RuntimeWorker {
  const ts = toIso(opts.now ?? FIXED_EPOCH);
  return {
    id: opts.id,
    host: `host-${opts.id}`,
    version: "0.1.0",
    capacity: opts.capacity ?? 4,
    status: "READY",
    load: { cpu: 0, memory: 0, inFlight: 0, queueDepth: 0, eventsPerSecond: 0 },
    startedAt: ts,
    lastHeartbeatAt: ts
  };
}

export function makeCheckpoint(opts: {
  executionId: string;
  workerId: string;
  sequence: number;
  phase?: ExecutionCheckpoint["phase"];
}): ExecutionCheckpoint {
  return {
    id: deterministicId([opts.executionId, opts.sequence, opts.workerId]),
    executionId: opts.executionId,
    workerId: opts.workerId,
    sequence: opts.sequence,
    phase: opts.phase ?? "PLANNING",
    state: { seq: opts.sequence },
    createdAt: toIso(new Date(FIXED_EPOCH.getTime() + opts.sequence * 1000))
  };
}

export function makeLeaseInput(opts: {
  executionId: string;
  workerId: string;
  ttlMs?: number;
  now?: Date;
}) {
  return {
    executionId: opts.executionId,
    workerId: opts.workerId,
    ttlMs: opts.ttlMs ?? 30_000,
    now: opts.now ?? new Date()
  };
}

/**
 * Postgres' uuid type accepts 32 lowercase hex chars without hyphens, so we
 * can derive a uuid-acceptable value from `deterministicId()` and use it as
 * an event id, agent id, or execution id. Centralized so test seeds are
 * obvious and reviewable.
 */
export function uuidFromHex(hex32: string): string {
  if (hex32.length !== 32) {
    // Defensive — deterministicId always returns 32 hex chars, but if the
    // caller passes something else we fall back to a random uuid so the test
    // still progresses (an assertion will catch the mismatch downstream).
    return randomUUID();
  }
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

/**
 * Generate a fresh, suite-unique seed prefix. Two suites in the same vitest
 * process never collide because each is anchored to the suite name + a
 * monotonic counter.
 */
let suiteCounter = 0;
export function suiteSeed(suiteName: string): string {
  return `${suiteName}#${++suiteCounter}#${process.pid}`;
}

/**
 * Persist an agent + execution row using raw SQL. The Sprint Next event store
 * needs valid FK targets in the legacy `agents`/`executions` tables for
 * `event_execution_links` to find anything to join against. This bypasses
 * the runtime so we can test the persistence layer in isolation.
 */
export async function seedAgentAndExecution(
  client: import("../../../src/infrastructure/persistence/postgres/pgClient.js").PgClient,
  opts: { agentId: string; executionId: string }
): Promise<void> {
  await client.query(
    `insert into agents (id, name, goal, state, runtime_status, model_provider, model_name,
       tools, memory_policy, created_at, updated_at)
     values ($1, $2, $3, 'IDLE', 'READY', 'mock', 'mock', '[]'::jsonb, '{}'::jsonb, $4, $4)
     on conflict (id) do nothing`,
    [opts.agentId, `seeded-${opts.agentId.slice(0, 6)}`, "test", toIso(FIXED_EPOCH)]
  );
  await client.query(
    `insert into executions (id, agent_id, status, input, started_at, updated_at)
     values ($1, $2, 'COMPLETED', '{}'::jsonb, $3, $3)
     on conflict (id) do nothing`,
    [opts.executionId, opts.agentId, toIso(FIXED_EPOCH)]
  );
}
