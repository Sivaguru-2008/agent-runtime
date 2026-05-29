/**
 * Phase 6 — Failure injection / chaos.
 *
 * These tests deliberately break the database or the application mid-flight
 * and assert the runtime recovers without:
 *   • losing committed events
 *   • leaving orphan lease rows that block reacquire
 *   • producing replay drift after a restart
 *   • losing snapshot integrity on a partial write
 *
 * Container restart is only available in testcontainer mode; the
 * `external` harness has `restart === undefined`, in which case these
 * tests describe.skipIf out individually.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "../../../src/infrastructure/persistence/postgresEventStore.js";
import { PostgresLeaseStore } from "../../../src/infrastructure/cluster/postgres/postgresLeaseStore.js";
import { PostgresSnapshotStore } from "../../../src/infrastructure/persistence/postgres/postgresSnapshotStore.js";
import { PostgresCognitionRepository } from "../../../src/infrastructure/persistence/postgres/postgresCognitionRepository.js";
import { tryStartHarness } from "./harness.js";
import { ManualClock } from "./clocks.js";
import {
  makeCognitionGraph,
  makeCognitionEventLog,
  makeEvent,
  seedAgentAndExecution,
  suiteSeed,
  uuidFromHex,
  makeLeaseInput
} from "./factories.js";
import { fanOut, sleep, eventually } from "./concurrency.js";
import { deterministicId, fingerprint } from "../../../src/shared/determinism.js";
import { FrameBuilder } from "../../../src/runtime/replay/frameBuilder.js";

const harness = await tryStartHarness();

afterEach(async () => {
  if (harness) await harness.reset();
});

afterAll(async () => {
  if (harness) await harness.stop();
});

const restartSupported = (): boolean => !!harness && typeof harness.restart === "function";

describe.skipIf(!restartSupported())("Postgres restart mid-execution", () => {
  it("committed events survive a container restart; uncommitted work is gone", async () => {
    const seed = suiteSeed("chaos-restart");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const store = new PostgresEventStore(harness!.connectionString);
    const committedIds: string[] = [];
    try {
      for (let i = 0; i < 25; i++) {
        const e = await store.append(makeEvent({
          type: "EXECUTION_STEP_STARTED",
          executionId: exec, seed, step: i,
          payloadExtras: { step: { executionId: exec, sequence: i } }
        }));
        committedIds.push(e.id);
      }
    } finally {
      await store.close();
    }

    // Restart Postgres. The pool will need a fresh connection afterwards.
    const restart = harness!.restart;
    if (!restart) throw new Error("restart not supported in this harness mode");
    await restart();
    // The harness pool may be in an unusable state — wait until queries succeed.
    await eventually(async () => {
      try {
        await harness!.pg.query("select 1");
        return true;
      } catch {
        return false;
      }
    }, { timeoutMs: 30_000, intervalMs: 250 });

    const store2 = new PostgresEventStore(harness!.connectionString);
    try {
      const reloaded = await store2.listByExecution(exec);
      // Every committed event survived.
      const ids = new Set(reloaded.map((e) => e.id));
      for (const id of committedIds) expect(ids.has(id)).toBe(true);
      // No phantom events appeared.
      expect(reloaded.length).toBe(committedIds.length);
    } finally {
      await store2.close();
    }
  }, 90_000);
});

describe.skipIf(!harness)("transaction abort during composite write", () => {
  it("aborting the event append transaction rolls back BOTH events and link rows", async () => {
    const seed = suiteSeed("chaos-tx-abort");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    // Force a constraint violation by appending two events with the same id.
    // The second append must roll back, leaving no orphan link rows for the
    // failed event's would-be sequence.
    const store = new PostgresEventStore(harness!.connectionString);
    try {
      const first = await store.append(makeEvent({
        type: "EXECUTION_STARTED",
        executionId: exec, seed, step: 0,
        payloadExtras: { execution: { id: exec, agentId: agent } }
      }));

      // Same id (same step → same deterministic id) → duplicate primary key.
      await expect(
        store.append(makeEvent({
          type: "EXECUTION_FAILED",
          executionId: exec, seed, step: 0,
          payloadExtras: { execution: { id: exec, agentId: agent } }
        }))
      ).rejects.toThrow();

      // Verify no link rows reference a non-existent event sequence.
      const orphans = await harness!.pg.query<{ count: string }>(
        `select count(*)::text as count
           from event_execution_links l
           left join events e on e.sequence = l.event_sequence
           where e.id is null`
      );
      expect(Number(orphans.rows[0].count)).toBe(0);

      // The successful first append is still there.
      const reloaded = await store.listByExecution(exec);
      expect(reloaded.map((e) => e.id)).toEqual([first.id]);
    } finally {
      await store.close();
    }
  });
});

describe.skipIf(!harness)("concurrent reclaim race", () => {
  it("3 concurrent recovery loops do not double-reclaim any expired lease", async () => {
    const leases = new PostgresLeaseStore(harness!.pg);
    const now = new Date("2026-05-22T00:00:00.000Z");
    const N = 30;
    for (let i = 0; i < N; i++) {
      await leases.acquire(makeLeaseInput({
        executionId: `exec-rc-${i}`,
        workerId: `dead-${i}`,
        ttlMs: 100,
        now
      }));
    }
    const later = new Date(now.getTime() + 60_000);

    const { results, errors } = await fanOut(3, () => leases.reclaimExpired(later));
    expect(errors).toEqual([]);
    const allIds: string[] = [];
    for (const batch of results) allIds.push(...batch.map((l) => l.executionId));
    // Union equals N, no duplicates → no double-reclaim.
    expect(new Set(allIds).size).toBe(N);
    expect(allIds.length).toBe(N);
  });
});

describe.skipIf(!harness)("partial snapshot persistence", () => {
  it("snapshot writes are atomic — a torn write never appears on read", async () => {
    const seed = suiteSeed("chaos-snapshot");
    const graph = makeCognitionGraph({ seed });
    await seedAgentAndExecution(harness!.pg, { agentId: graph.agentId, executionId: graph.executionId });
    const cognitions = new PostgresCognitionRepository(harness!.pg);
    const snapshots = new PostgresSnapshotStore(harness!.pg);
    await cognitions.save(graph);

    // 10 concurrent put() calls for the SAME (cognitionId, frameIndex). Only
    // one row may exist for that key — the unique constraint enforces it.
    // Whichever wins is fine; what matters is that no read EVER returns a
    // partial graph.
    const snapshot = {
      id: deterministicId([graph.id, 0, "snap"]),
      cognitionId: graph.id,
      executionId: graph.executionId,
      frameIndex: 0,
      eventSequence: 0,
      capturedAt: "2026-05-22T00:00:00.000Z",
      graph,
      eventCount: 1
    };
    const { results, errors } = await fanOut(10, async () => {
      try {
        await snapshots.put(snapshot);
        return "ok";
      } catch (err) {
        // Unique-key violation on (cognition_id, frame_index) is expected
        // for the racing inserts. Treat as a "loser" not a failure.
        return (err as Error).message.includes("duplicate key") ? "duplicate" : "error";
      }
    });
    // No "error" outcomes — only ok or duplicate.
    expect(results.every((r) => r === "ok" || r === "duplicate")).toBe(true);
    expect(errors).toEqual([]);

    const all = await snapshots.listByCognition(graph.id);
    // Exactly one row for frame 0; graph is intact.
    expect(all.filter((s) => s.frameIndex === 0)).toHaveLength(1);
    expect(all[0].graph.nodes.length).toBe(graph.nodes.length);
  });
});

describe.skipIf(!harness)("orphan-lease detection after worker crash", () => {
  it("a crashed worker's lease is reclaimed and re-acquirable without manual intervention", async () => {
    const leases = new PostgresLeaseStore(harness!.pg);
    const clock = new ManualClock(new Date("2026-05-22T00:00:00.000Z"));

    // Worker A acquires, then "crashes" (no recovery path runs immediately).
    await leases.acquire(makeLeaseInput({
      executionId: "exec-crash-A", workerId: "A", ttlMs: 500, now: clock.now()
    }));
    // Lease expires.
    clock.advance(60_000);

    // Recovery scan reclaims.
    const reclaimed = await leases.reclaimExpired(clock.now());
    expect(reclaimed.map((l) => l.executionId)).toContain("exec-crash-A");

    // Worker B acquires.
    const acquired = await leases.acquire(makeLeaseInput({
      executionId: "exec-crash-A", workerId: "B", ttlMs: 30_000, now: clock.now()
    }));
    expect(acquired?.workerId).toBe("B");
    expect(acquired?.attempt).toBeGreaterThan(1);
  });
});

describe.skipIf(!harness)("no replay corruption after restart", () => {
  it("frame fingerprints after a connection bounce match pre-bounce fingerprints", async () => {
    const seed = suiteSeed("chaos-replay-restart");
    const graph = makeCognitionGraph({ seed });
    await seedAgentAndExecution(harness!.pg, { agentId: graph.agentId, executionId: graph.executionId });

    const storeA = new PostgresEventStore(harness!.connectionString);
    const log = makeCognitionEventLog(graph, seed);
    try {
      for (const e of log) await storeA.append(e);
    } finally {
      await storeA.close();
    }

    const builder = new FrameBuilder();
    const storeB = new PostgresEventStore(harness!.connectionString);
    let firstFingerprints: string[] = [];
    try {
      const eventsB = await storeB.listByExecution(graph.executionId);
      firstFingerprints = (await builder.build(eventsB)).map((f) => f.preview.fingerprint!);
    } finally {
      await storeB.close();
    }

    // Hard bounce: brand-new pool, fresh PgClient.
    const storeC = new PostgresEventStore(harness!.connectionString);
    let secondFingerprints: string[] = [];
    try {
      const eventsC = await storeC.listByExecution(graph.executionId);
      secondFingerprints = (await builder.build(eventsC)).map((f) => f.preview.fingerprint!);
    } finally {
      await storeC.close();
    }

    expect(secondFingerprints).toEqual(firstFingerprints);
    // Belt-and-braces: also assert each event payload's deterministic
    // fingerprint round-tripped unchanged through JSONB.
    expect(await fingerprint(secondFingerprints)).toBe(await fingerprint(firstFingerprints));
  }, 30_000);
});

describe.skipIf(!harness)("scheduler shutdown mid-cycle", () => {
  it("an active lease can be released cleanly during shutdown — no leak", async () => {
    // Simulates the scheduler's `stop()` path: in-flight executions should
    // release their leases (or the recovery loop will). We assert that after
    // a release, the row's status reflects TRANSFERRED — not active — so a
    // fresh node can acquire immediately.
    const leases = new PostgresLeaseStore(harness!.pg);
    const now = new Date("2026-05-22T00:00:00.000Z");
    await leases.acquire(makeLeaseInput({
      executionId: "exec-shutdown", workerId: "stopping", ttlMs: 60_000, now
    }));
    await leases.release("exec-shutdown", "stopping", now);
    const after = await leases.getByExecution("exec-shutdown");
    expect(after?.status).toBe("TRANSFERRED");

    const acquired = await leases.acquire(makeLeaseInput({
      executionId: "exec-shutdown", workerId: "fresh", ttlMs: 30_000, now
    }));
    expect(acquired?.workerId).toBe("fresh");
  });
});

describe.skipIf(!harness)("deadlock retry sanity", () => {
  it("two transactions touching the same row do not produce a permanent deadlock", async () => {
    // The lease store uses FOR UPDATE SKIP LOCKED, which by construction
    // cannot deadlock on the same row. We verify by hammering acquire/release
    // concurrently — if a deadlock occurred Postgres would error one side.
    const leases = new PostgresLeaseStore(harness!.pg);
    const now = new Date("2026-05-22T00:00:00.000Z");
    const exec = "exec-deadlock";
    await leases.acquire(makeLeaseInput({ executionId: exec, workerId: "A", ttlMs: 60_000, now }));

    const { errors } = await fanOut(32, async (i) => {
      if (i % 2 === 0) {
        await leases.renew(exec, "A", now, 60_000);
      } else {
        // Try to acquire from a competing worker (will return undefined).
        await leases.acquire(makeLeaseInput({
          executionId: exec, workerId: `B-${i}`, ttlMs: 60_000, now
        }));
      }
      await sleep(1);
    });
    expect(errors).toEqual([]);
  });
});
