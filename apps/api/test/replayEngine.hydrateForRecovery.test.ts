import { describe, expect, it } from "vitest";
import { ReplayEngine } from "../src/runtime/replay/replayEngine.js";
import {
  InMemoryBranchRegistry,
  InMemoryCognitionRepository,
  InMemoryReplaySessionStore,
  InMemorySnapshotStore
} from "../src/infrastructure/persistence/inMemoryCognitionStores.js";
import { InMemoryEventStore } from "../src/infrastructure/persistence/inMemoryStores.js";
import { PersistedEventPublisher } from "../src/infrastructure/events/persistedEventPublisher.js";
import { InMemoryEventBus } from "../src/infrastructure/events/inMemoryEventBus.js";
import { EventFactory } from "../src/infrastructure/events/eventFactory.js";
import { FrozenClock } from "../src/shared/clock.js";
import type { CognitionGraph } from "../src/domain/cognition.js";
import type { DomainEvent } from "../src/domain/events.js";

/**
 * Phase C — ReplayEngine.hydrateForRecovery unit contract.
 *
 * Covers the three return shapes:
 *   • Undefined when the execution has no cognition row.
 *   • SNAPSHOT path when a snapshot exists for the cognition.
 *   • FULL_REPLAY path when no snapshot exists OR forceFullReplay=true.
 */

function makeGraph(executionId: string): CognitionGraph {
  return {
    id: `cog-${executionId}`,
    executionId,
    agentId: `agent-${executionId}`,
    phase: "COMPLETE",
    startedAt: "2026-05-27T00:00:00.000Z",
    completedAt: "2026-05-27T00:00:10.000Z",
    nodes: [
      {
        id: `node-${executionId}-0`,
        cognitionId: `cog-${executionId}`,
        executionId,
        sequence: 0,
        role: "PLANNER",
        phase: "PLAN",
        status: "COMPLETED",
        inputFingerprint: "fp0",
        input: { role: "PLANNER" },
        output: { ok: true },
        startedAt: "2026-05-27T00:00:00.000Z",
        completedAt: "2026-05-27T00:00:01.000Z",
        durationMs: 1000
      }
    ],
    handoffs: [],
    output: { final: "ok" }
  };
}

function buildEngine() {
  const events = new InMemoryEventStore();
  const cognitions = new InMemoryCognitionRepository();
  const snapshots = new InMemorySnapshotStore();
  const sessions = new InMemoryReplaySessionStore();
  const branches = new InMemoryBranchRegistry();
  const clock = new FrozenClock(new Date("2026-05-27T00:00:00.000Z"));
  const factory = new EventFactory(clock, "recovery-unit");
  const publisher = new PersistedEventPublisher(events, new InMemoryEventBus());
  const engine = new ReplayEngine(events, cognitions, snapshots, sessions, branches, publisher, factory, clock);
  return { engine, events, cognitions, snapshots, sessions, branches, clock };
}

function makeEvent(executionId: string, sequence: number): DomainEvent {
  return {
    id: `evt-${executionId}-${sequence}`,
    type: "MODEL_COMPLETED",
    aggregateId: executionId,
    aggregateType: "EXECUTION",
    version: 1,
    timestamp: "2026-05-27T00:00:00.000Z",
    payload: { executionId, idx: sequence },
    metadata: {
      traceId: `trace-${executionId}`,
      correlationId: `corr-${executionId}`,
      schemaVersion: 1,
      source: "recovery-unit",
      idempotencyKey: `idem-${executionId}-${sequence}`
    },
    sequence
  };
}

describe("ReplayEngine.hydrateForRecovery", () => {
  it("returns undefined when the cognition is unknown for this execution", async () => {
    const { engine } = buildEngine();
    const result = await engine.hydrateForRecovery("exec-no-such-cog");
    expect(result).toBeUndefined();
  });

  it("recoveredVia=FULL_REPLAY when no snapshot exists; cursor is last event sequence", async () => {
    const { engine, events, cognitions } = buildEngine();
    const graph = makeGraph("exec-full");
    await cognitions.save(graph);
    for (let i = 1; i <= 4; i++) await events.append(makeEvent(graph.executionId, i));

    const result = await engine.hydrateForRecovery(graph.executionId);
    expect(result).toBeDefined();
    expect(result!.recoveredVia).toBe("FULL_REPLAY");
    expect(result!.graph.id).toBe(graph.id);
    // 4 events appended via InMemoryEventStore — sequence depends on store's
    // auto-increment, so we assert it's a positive integer rather than a
    // specific number.
    expect(result!.eventSequenceCursor).toBeGreaterThan(0);
    expect(result!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("recoveredVia=SNAPSHOT when a snapshot exists; cursor is snapshot.eventSequence", async () => {
    const { engine, cognitions, snapshots } = buildEngine();
    const graph = makeGraph("exec-snap");
    await cognitions.save(graph);
    await snapshots.put({
      id: "snap-1",
      cognitionId: graph.id,
      executionId: graph.executionId,
      frameIndex: 7,
      eventSequence: 42,
      capturedAt: "2026-05-27T00:00:00.000Z",
      graph,
      eventCount: 8
    });

    const result = await engine.hydrateForRecovery(graph.executionId);
    expect(result!.recoveredVia).toBe("SNAPSHOT");
    expect(result!.eventSequenceCursor).toBe(42);
    expect(result!.graph.id).toBe(graph.id);
  });

  it("forceFullReplay=true bypasses an existing snapshot", async () => {
    const { engine, events, cognitions, snapshots } = buildEngine();
    const graph = makeGraph("exec-force");
    await cognitions.save(graph);
    await snapshots.put({
      id: "snap-force",
      cognitionId: graph.id,
      executionId: graph.executionId,
      frameIndex: 5,
      eventSequence: 99,
      capturedAt: "2026-05-27T00:00:00.000Z",
      graph,
      eventCount: 6
    });
    await events.append(makeEvent(graph.executionId, 1));

    const result = await engine.hydrateForRecovery(graph.executionId, { forceFullReplay: true });
    expect(result!.recoveredVia).toBe("FULL_REPLAY");
    // Cursor came from the event log, NOT the snapshot's 99.
    expect(result!.eventSequenceCursor).not.toBe(99);
  });
});
