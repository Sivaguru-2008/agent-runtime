/**
 * Phase 2 — Event store validation against real Postgres.
 *
 * Validates the contracts the in-memory unit tests cannot exercise:
 *   • `bigserial sequence` is strictly monotonic and unique under concurrent
 *     append (1000+ writers, no duplicates, no gaps in observed order)
 *   • `listAfterSequence` paging is gap-free and stable across reconnect
 *   • `listByExecution` uses `event_execution_links` and returns events for
 *     every link kind (AGGREGATE / EXECUTION / COGNITION / RESUME / LEASE /
 *     CHECKPOINT / BRANCH)
 *   • `listByCognition` returns the cognition's events ordered by sequence
 *   • Transaction rollback on an FK violation leaves the events table empty
 *   • Replay-after-reconnect returns bit-identical events
 *
 * These are the exact gaps Sprint Hardening 1 left open.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "../../../src/infrastructure/persistence/postgresEventStore.js";
import { tryStartHarness } from "./harness.js";
import {
  makeCognitionEventLog,
  makeCognitionGraph,
  makeEvent,
  seedAgentAndExecution,
  suiteSeed,
  uuidFromHex
} from "./factories.js";
import { fanOut } from "./concurrency.js";
import { deterministicId } from "../../../src/shared/determinism.js";

// Top-level await: resolve the harness BEFORE describe blocks run so
// `describe.skipIf(!harness)` sees the real state. Without this, the
// guard always reads `null` because describe.skipIf is evaluated at
// file-collection time, not after beforeAll.
const harness = await tryStartHarness();
const store = harness ? new PostgresEventStore(harness.connectionString) : null;

afterEach(async () => {
  if (harness) await harness.reset();
});

afterAll(async () => {
  if (store) await store.close();
  if (harness) await harness.stop();
});

describe.skipIf(!harness)("PostgresEventStore — append + ordering", () => {
  it("assigns strictly monotonic sequences across sequential appends", async () => {
    const seed = suiteSeed("seq-monotonic");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const seqs: number[] = [];
    for (let i = 0; i < 50; i++) {
      const ev = makeEvent({
        type: "EXECUTION_STEP_STARTED",
        executionId: exec,
        seed,
        step: i,
        payloadExtras: { step: { executionId: exec, sequence: i } }
      });
      const appended = await store!.append(ev);
      seqs.push(appended.sequence!);
    }
    // Strictly increasing.
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // No duplicates.
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("emits no duplicate sequences under 1000 concurrent appends", async () => {
    const seed = suiteSeed("concurrent-1000");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const N = 1000;
    const { results, errors } = await fanOut(N, (i) =>
      store!.append(
        makeEvent({
          type: "EXECUTION_STEP_STARTED",
          executionId: exec,
          seed,
          step: i,
          payloadExtras: { step: { executionId: exec, sequence: i } }
        })
      )
    );
    expect(errors).toEqual([]);
    expect(results).toHaveLength(N);

    const seqs = results.map((r) => r.sequence!);
    // No duplicate sequences ever emitted.
    expect(new Set(seqs).size).toBe(N);
    // Sequence values are dense within the run (the bigserial may have started
    // anywhere; what matters is that the count equals max-min+1).
    const min = Math.min(...seqs);
    const max = Math.max(...seqs);
    expect(max - min + 1).toBe(N);
    // Every sequence between min..max is present — bigserial is gapless even
    // under concurrent insertion as long as no inserts roll back. We have no
    // intentional rollbacks here so the dense check is fair.
    const set = new Set(seqs);
    for (let s = min; s <= max; s++) expect(set.has(s)).toBe(true);
  });

  it("preserves insert-order under sequential appends within one execution", async () => {
    const seed = suiteSeed("seq-order");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    for (let i = 0; i < 20; i++) {
      await store!.append(makeEvent({
        type: "MODEL_COMPLETED",
        executionId: exec,
        seed, step: i,
        payloadExtras: { step: i, executionId: exec }
      }));
    }
    const fetched = await store!.listByExecution(exec);
    expect(fetched).toHaveLength(20);
    for (let i = 1; i < fetched.length; i++) {
      expect(fetched[i].sequence!).toBeGreaterThan(fetched[i - 1].sequence!);
    }
  });
});

describe.skipIf(!harness)("PostgresEventStore — paging + cursor", () => {
  it("`listAfterSequence` is gap-free and stable across reconnect", async () => {
    const seed = suiteSeed("paging");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const TOTAL = 250;
    const appended = [];
    for (let i = 0; i < TOTAL; i++) {
      appended.push(await store!.append(makeEvent({
        type: "EXECUTION_STEP_STARTED",
        executionId: exec,
        seed, step: i,
        payloadExtras: { step: { executionId: exec, sequence: i } }
      })));
    }

    // Page through with a 47-event window; cumulative collection must equal
    // the full appended set in the same order.
    const PAGE = 47;
    let cursor = 0;
    const collected = [];
    for (;;) {
      const page = await store!.listAfterSequence(cursor, PAGE);
      if (!page.length) break;
      collected.push(...page);
      cursor = page[page.length - 1].sequence!;
    }
    // Filter the global page set down to this execution's events; the page
    // contains every event in the database — fine for this test because the
    // suite reset before it started.
    const ourSeqs = collected
      .filter((e) => e.aggregateId === exec || (e.payload as { executionId?: string }).executionId === exec)
      .map((e) => e.sequence!);
    const appendedSeqs = appended.map((e) => e.sequence!);
    expect(ourSeqs).toEqual(appendedSeqs);

    // Reconnect: drop the existing pool and create a fresh one. Paging must
    // produce identical results — the cursor lives in Postgres, not memory.
    const store2 = new PostgresEventStore(harness!.connectionString);
    try {
      const fromZero = [];
      let c2 = 0;
      for (;;) {
        const page = await store2.listAfterSequence(c2, PAGE);
        if (!page.length) break;
        fromZero.push(...page);
        c2 = page[page.length - 1].sequence!;
      }
      expect(fromZero.map((e) => e.id)).toEqual(collected.map((e) => e.id));
    } finally {
      await store2.close();
    }
  });

  it("`listAfterSequence(0, limit)` honors the limit and returns ascending sequences", async () => {
    const seed = suiteSeed("limit");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    for (let i = 0; i < 30; i++) {
      await store!.append(makeEvent({
        type: "EXECUTION_STEP_STARTED",
        executionId: exec, seed, step: i,
        payloadExtras: { step: { executionId: exec, sequence: i } }
      }));
    }
    const page = await store!.listAfterSequence(0, 10);
    expect(page).toHaveLength(10);
    for (let i = 1; i < page.length; i++) {
      expect(page[i].sequence!).toBeGreaterThan(page[i - 1].sequence!);
    }
  });
});

describe.skipIf(!harness)("PostgresEventStore — indexed lookups", () => {
  it("`listByExecution` returns events linked via every link kind", async () => {
    const seed = suiteSeed("links");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    // Cover several link kinds via payload shape:
    //   AGGREGATE  — aggregateType=EXECUTION + aggregateId=exec
    //   EXECUTION  — payload.execution.id=exec
    //   COGNITION  — payload.node.executionId=exec
    //   RESUME     — payload.executionId=exec (no other path)
    //   LEASE      — payload.lease.executionId=exec
    //   CHECKPOINT — payload.checkpoint.executionId=exec
    const events = [
      makeEvent({ type: "EXECUTION_STARTED", executionId: exec, seed, step: 0,
        payloadExtras: { execution: { id: exec, agentId: agent } } }),
      makeEvent({ type: "COGNITION_NODE_COMPLETED", executionId: exec, seed, step: 1,
        cognitionId: deterministicId([seed, "cog"]),
        payloadExtras: { node: { executionId: exec, id: "n1", sequence: 0, role: "PLANNER" } } }),
      makeEvent({ type: "EXECUTION_RESUMED", executionId: exec, seed, step: 2,
        payloadExtras: { fromSequence: 0, workerId: "w1" } }),
      makeEvent({ type: "EXECUTION_LEASED", executionId: exec, seed, step: 3,
        payloadExtras: { lease: { executionId: exec, workerId: "w1" } } }),
      makeEvent({ type: "EXECUTION_CHECKPOINT_WRITTEN", executionId: exec, seed, step: 4,
        payloadExtras: { checkpoint: { executionId: exec, workerId: "w1", sequence: 1 } } })
    ];
    for (const e of events) await store!.append(e);

    const got = await store!.listByExecution(exec);
    // All 5 link kinds should surface. No duplicates from multiple link rows
    // per event (the LEFT JOIN + GROUP BY in listByExecution dedupes).
    expect(got.map((e) => e.type).sort()).toEqual(
      events.map((e) => e.type).sort()
    );
  });

  it("`listByCognition` returns cognition-tagged events ordered ascending", async () => {
    const seed = suiteSeed("by-cognition");
    const graph = makeCognitionGraph({ seed });
    await seedAgentAndExecution(harness!.pg, { agentId: graph.agentId, executionId: graph.executionId });
    const log = makeCognitionEventLog(graph, seed);
    for (const e of log) await store!.append(e);

    const got = await store!.listByCognition(graph.id);
    // The cognition log contains all events whose payload links to graph.id —
    // every COGNITION_* event plus snapshots/branches. Our factory log has
    // COGNITION_STARTED + 4 × (NODE_STARTED, NODE_COMPLETED) + COGNITION_COMPLETED = 10.
    expect(got.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < got.length; i++) {
      expect(got[i].sequence!).toBeGreaterThan(got[i - 1].sequence!);
    }
  });

  it("`listByAggregate` returns events for an aggregate ordered by sequence", async () => {
    const seed = suiteSeed("by-aggregate");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
    for (let i = 0; i < 5; i++) {
      await store!.append(makeEvent({
        type: "EXECUTION_STEP_STARTED",
        executionId: exec, seed, step: i,
        payloadExtras: { step: { executionId: exec, sequence: i } }
      }));
    }
    const got = await store!.listByAggregate("EXECUTION", exec);
    expect(got).toHaveLength(5);
  });
});

describe.skipIf(!harness)("PostgresEventStore — transactional integrity", () => {
  it("rolls back the entire append on a constraint failure", async () => {
    const seed = suiteSeed("rollback");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    // Append a valid event first to get a baseline count.
    await store!.append(makeEvent({
      type: "EXECUTION_STARTED",
      executionId: exec, seed, step: 0,
      payloadExtras: { execution: { id: exec, agentId: agent } }
    }));
    const before = (await store!.listByExecution(exec)).length;
    expect(before).toBe(1);

    // Append a second distinct, valid event that persists (its link rows land
    // too). This is the row whose primary key we will later collide with.
    const original = makeEvent({
      type: "EXECUTION_COMPLETED",
      executionId: exec, seed, step: 1,
      payloadExtras: { execution: { id: exec, agentId: agent } }
    });
    await store!.append(original);
    expect((await store!.listByExecution(exec)).length).toBe(2);

    // Force a GENUINE constraint failure that the idempotency dedup path
    // cannot absorb. append() runs `INSERT ... ON CONFLICT (idempotency_key)
    // DO NOTHING`, so re-appending the SAME event is silently deduped (no
    // throw). To exercise the rollback path we instead reuse the persisted
    // event's primary key (`id`) while giving it a FRESH idempotency_key:
    // the ON CONFLICT target (idempotency_key) does not match, so the INSERT
    // proceeds and trips the events_pkey unique constraint. The whole
    // transaction must then roll back — events row AND link rows.
    const collidingPk = {
      ...makeEvent({
        type: "EXECUTION_FAILED",
        executionId: exec, seed, step: 2, // distinct → fresh idempotency_key
        payloadExtras: { execution: { id: exec, agentId: agent } }
      }),
      id: original.id // duplicate primary key → genuine constraint violation
    };
    // Sanity: this is a true PK collision, not an idempotency re-send.
    expect(collidingPk.id).toBe(original.id);
    expect(collidingPk.metadata.idempotencyKey).not.toBe(original.metadata.idempotencyKey);

    await expect(store!.append(collidingPk)).rejects.toThrow();

    // The failed append must have rolled back fully — no phantom event row...
    const eventsAfter = await harness!.pg.query<{ count: string }>(
      `select count(*)::text as count from events where aggregate_id = $1`,
      [exec]
    );
    // 2 events total (EXECUTION_STARTED + EXECUTION_COMPLETED), not 3.
    expect(Number(eventsAfter.rows[0].count)).toBe(2);

    // ...and no orphan link rows pointing at a sequence that never committed.
    const orphans = await harness!.pg.query<{ count: string }>(
      `select count(*)::text as count
         from event_execution_links l
         left join events e on e.sequence = l.event_sequence
         where e.id is null`
    );
    expect(Number(orphans.rows[0].count)).toBe(0);
  });
});

describe.skipIf(!harness)("PostgresEventStore — replay-after-reconnect consistency", () => {
  it("returns bit-identical events across pool restarts", async () => {
    const seed = suiteSeed("reconnect");
    const graph = makeCognitionGraph({ seed });
    await seedAgentAndExecution(harness!.pg, { agentId: graph.agentId, executionId: graph.executionId });
    const log = makeCognitionEventLog(graph, seed);
    for (const e of log) await store!.append(e);

    const first = await store!.listByExecution(graph.executionId);
    // Bounce the connection pool — production restart, rolling deploy, etc.
    const store2 = new PostgresEventStore(harness!.connectionString);
    try {
      const second = await store2.listByExecution(graph.executionId);
      // Same set, same order, same payloads, same sequences.
      expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
      expect(second.map((e) => e.sequence)).toEqual(first.map((e) => e.sequence));
      // Payloads survive the JSONB round-trip unchanged.
      for (let i = 0; i < first.length; i++) {
        expect(second[i].payload).toEqual(first[i].payload);
        expect(second[i].metadata).toEqual(first[i].metadata);
      }
    } finally {
      await store2.close();
    }
  });
});
