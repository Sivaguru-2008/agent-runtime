/**
 * OutboxDispatcher crash-recovery correctness suite.
 *
 * Guarantee under test: "every committed outbox event is eventually delivered,
 * surviving a worker crash mid-dispatch."
 *
 * Failure mode this file used to characterize (now FIXED):
 *   tickDatabase() claimed a batch by flipping rows PENDING → PROCESSING and
 *   setting visible_after = now + 30s. If the process crashed after the claim
 *   but before delete/DLQ, the row stayed PROCESSING forever — the claim
 *   CTE filtered status='PENDING', so the stranded row was never re-selected,
 *   and the per-execution FIFO gate (prev.status in ('PENDING','PROCESSING'))
 *   permanently blocked every later event for that execution.
 *
 * Fix shipped in this commit:
 *   The claim CTE now also reclaims status='PROCESSING' rows whose
 *   visible_after has elapsed (SQS-style visibility-timeout reaper). The
 *   FIFO gate treats *stale* PROCESSING rows as eligible-to-displace, so
 *   later events are no longer head-of-line blocked. Row-level
 *   `for update skip locked` prevents two workers from racing on the same
 *   reclaim. Reclaimed rows have retry_count bumped and last_error stamped
 *   with STRANDED_RECOVERY_MARKER for telemetry; MAX_RETRIES still bounds
 *   thrash on genuinely poison rows.
 *
 * These tests assert the CORRECT behavior — they will fail if the recovery
 * path regresses.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "../../../src/infrastructure/persistence/postgresEventStore.js";
import {
  OutboxDispatcher,
  STRANDED_RECOVERY_MARKER
} from "../../../src/infrastructure/events/outboxDispatcher.js";
import { PersistedEventPublisher } from "../../../src/infrastructure/events/persistedEventPublisher.js";
import { tryStartHarness } from "./harness.js";
import { makeEvent, seedAgentAndExecution, suiteSeed, uuidFromHex } from "./factories.js";
import { deterministicId } from "../../../src/shared/determinism.js";
import type { DomainEvent } from "../../../src/domain/events.js";
import type { EventBus, EventHandler } from "../../../src/domain/ports.js";

const harness = await tryStartHarness();
const store = harness ? new PostgresEventStore(harness.connectionString) : null;

afterEach(async () => {
  if (harness) await harness.reset();
});
afterAll(async () => {
  if (store) await store.close();
  if (harness) await harness.stop();
});

class WorkingBus implements EventBus {
  readonly published: DomainEvent[] = [];
  private readonly handlers = new Set<EventHandler>();
  async publish(event: DomainEvent): Promise<void> {
    this.published.push(event);
    await Promise.all([...this.handlers].map((h) => h(event)));
  }
  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

/**
 * Bus that blocks on a Promise that the test resolves later. Used to model a
 * worker that claimed an outbox row, started bus.publish(), and then
 * "crashed" — i.e. never completed publish. We achieve this by abandoning
 * the in-flight tick() and inspecting the DB state directly.
 */
class StallingBus implements EventBus {
  readonly published: DomainEvent[] = [];
  private readonly handlers = new Set<EventHandler>();
  private gate: Promise<void> = new Promise(() => { /* never resolves */ });
  async publish(event: DomainEvent): Promise<void> {
    // Wait forever — the calling tick() Promise is abandoned by the test.
    await this.gate;
    this.published.push(event);
  }
  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

async function seedOutboxRow(
  exec: string,
  ev: DomainEvent,
  seq: number,
  status: "PENDING" | "PROCESSING",
  visibleAfter: Date,
  rowId: string
): Promise<void> {
  await harness!.pg.query(
    `insert into events (id, type, aggregate_id, aggregate_type, version, timestamp, payload, metadata, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) on conflict do nothing`,
    [ev.id, ev.type, ev.aggregateId, ev.aggregateType, ev.version, ev.timestamp,
     JSON.stringify(ev.payload), JSON.stringify(ev.metadata), ev.metadata.idempotencyKey]
  );
  await harness!.pg.query(
    `insert into event_outbox (id, event_id, execution_id, event_type, payload, metadata, sequence, idempotency_key, status, visible_after, original_timestamp)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)`,
    [rowId, ev.id, exec, ev.type, JSON.stringify(ev.payload), JSON.stringify(ev.metadata),
     seq, ev.metadata.idempotencyKey, status, visibleAfter.toISOString(), ev.timestamp]
  );
}

describe.skipIf(!harness)("OutboxDispatcher — crash recovery for stranded PROCESSING rows", () => {
  it("reclaims and redelivers a PROCESSING row abandoned by a crashed worker once its visibility timeout elapses", async () => {
    const seed = suiteSeed("recover-stranded");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    // Simulate a crash: a previous worker claimed the row (PROCESSING) with a
    // visibility deadline 10 minutes in the past.
    await seedOutboxRow(exec, ev, 1, "PROCESSING", new Date(Date.now() - 600_000),
      uuidFromHex(deterministicId([seed, "row"])));

    const bus = new WorkingBus();
    const dispatcher = new OutboxDispatcher(new PersistedEventPublisher(store!, bus), bus, harness!.pg);

    const delivered = await dispatcher.drainAll();

    // Correct behavior: the stranded row is reclaimed, redelivered, and removed.
    expect(delivered).toBe(1);
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].id).toBe(ev.id);
    const row = await harness!.pg.query(
      `select status from event_outbox where execution_id = $1`,
      [exec]
    );
    expect(row.rows).toHaveLength(0); // deleted on successful delivery
  });

  it("unblocks later PENDING events behind a stranded PROCESSING row at an earlier sequence (no FIFO head-of-line stall)", async () => {
    const seed = suiteSeed("recover-fifo-unstall");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const stuck = makeEvent({ type: "EXECUTION_STEP_STARTED", executionId: exec, seed, step: 0 });
    const later = makeEvent({ type: "EXECUTION_STEP_COMPLETED", executionId: exec, seed, step: 1 });
    await seedOutboxRow(exec, stuck, 1, "PROCESSING", new Date(Date.now() - 600_000),
      uuidFromHex(deterministicId([seed, "row-stuck"])));
    await seedOutboxRow(exec, later, 2, "PENDING", new Date(Date.now() - 1000),
      uuidFromHex(deterministicId([seed, "row-later"])));

    const bus = new WorkingBus();
    const dispatcher = new OutboxDispatcher(new PersistedEventPublisher(store!, bus), bus, harness!.pg);

    const delivered = await dispatcher.drainAll();

    // Both rows must drain, in FIFO order (seq=1 before seq=2).
    expect(delivered).toBe(2);
    expect(bus.published.map((e) => e.id)).toEqual([stuck.id, later.id]);
    const rows = await harness!.pg.query(
      `select status from event_outbox where execution_id = $1`,
      [exec]
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe.skipIf(!harness)("OutboxDispatcher — recovery edge cases", () => {
  it("crash after PROCESSING claim: the row remains PROCESSING but is recovered on the next tick once visibility elapses", async () => {
    const seed = suiteSeed("crash-after-claim");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    // Insert a normal PENDING row that the "crashing" worker will claim.
    await seedOutboxRow(exec, ev, 1, "PENDING", new Date(Date.now() - 1000),
      uuidFromHex(deterministicId([seed, "row"])));

    // Worker A's bus hangs forever in publish(). We fire-and-forget its tick()
    // to simulate the worker crashing AFTER the claim — the claim CTE commits
    // (status -> PROCESSING) but the bus.publish() never returns.
    const hangingBus = new StallingBus();
    const crashingDispatcher = new OutboxDispatcher(
      new PersistedEventPublisher(store!, hangingBus),
      hangingBus,
      harness!.pg,
      undefined,
      // 1s visibility timeout so the test does not have to wait 30s for recovery.
      { visibilityTimeoutSec: 1 }
    );
    void crashingDispatcher.tick().catch(() => { /* abandoned */ });

    // Wait until the claim has actually committed the PROCESSING transition.
    await waitFor(async () => {
      const r = await harness!.pg.query(`select status from event_outbox where event_id = $1`, [ev.id]);
      return (r.rows[0] as { status?: string } | undefined)?.status === "PROCESSING";
    });
    const stranded = await harness!.pg.query(
      `select status, visible_after from event_outbox where event_id = $1`,
      [ev.id]
    );
    expect((stranded.rows[0] as { status: string }).status).toBe("PROCESSING");
    expect(hangingBus.published).toHaveLength(0); // worker never delivered

    // Wait past the visibility timeout, then start a fresh dispatcher (Worker B).
    await sleep(1100);

    const liveBus = new WorkingBus();
    const recovery = new OutboxDispatcher(
      new PersistedEventPublisher(store!, liveBus),
      liveBus,
      harness!.pg,
      undefined,
      { visibilityTimeoutSec: 1 }
    );
    const delivered = await recovery.drainAll();

    expect(delivered).toBe(1);
    expect(liveBus.published).toHaveLength(1);
    expect(liveBus.published[0].id).toBe(ev.id);
    const after = await harness!.pg.query(`select * from event_outbox where event_id = $1`, [ev.id]);
    expect(after.rows).toHaveLength(0);
  });

  it("restart recovery: a brand-new dispatcher instance picks up rows stranded by a previous process", async () => {
    const seed = suiteSeed("restart");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev1 = makeEvent({ type: "EXECUTION_STEP_STARTED", executionId: exec, seed, step: 0 });
    const ev2 = makeEvent({ type: "EXECUTION_STEP_COMPLETED", executionId: exec, seed, step: 1 });
    // Two rows stranded by the prior process — both PROCESSING with elapsed visibility.
    await seedOutboxRow(exec, ev1, 1, "PROCESSING", new Date(Date.now() - 5000),
      uuidFromHex(deterministicId([seed, "row1"])));
    await seedOutboxRow(exec, ev2, 2, "PROCESSING", new Date(Date.now() - 5000),
      uuidFromHex(deterministicId([seed, "row2"])));

    // Brand-new dispatcher (publisher, bus, dispatcher) — no in-process state
    // carried over from the "crashed" worker.
    const bus = new WorkingBus();
    const dispatcher = new OutboxDispatcher(
      new PersistedEventPublisher(store!, bus),
      bus,
      harness!.pg
    );

    const delivered = await dispatcher.drainAll();

    expect(delivered).toBe(2);
    expect(bus.published.map((e) => e.id)).toEqual([ev1.id, ev2.id]);
    const rows = await harness!.pg.query(`select * from event_outbox where execution_id = $1`, [exec]);
    expect(rows.rows).toHaveLength(0);
  });

  it("duplicate recovery attempts are safe: subsequent drainAll() calls are no-ops, never re-publish", async () => {
    const seed = suiteSeed("dup-recovery");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    await seedOutboxRow(exec, ev, 1, "PROCESSING", new Date(Date.now() - 600_000),
      uuidFromHex(deterministicId([seed, "row"])));

    const bus = new WorkingBus();
    const dispatcher = new OutboxDispatcher(new PersistedEventPublisher(store!, bus), bus, harness!.pg);

    const first = await dispatcher.drainAll();
    const second = await dispatcher.drainAll();
    const third = await dispatcher.drainAll();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(third).toBe(0);
    expect(bus.published).toHaveLength(1); // delivered exactly once
    const rows = await harness!.pg.query(`select * from event_outbox where event_id = $1`, [ev.id]);
    expect(rows.rows).toHaveLength(0);
  });

  it("concurrent recovery workers: two dispatchers contending on the same stranded rows deliver each event exactly once between them", async () => {
    const seed = suiteSeed("concurrent-recovery");
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    // 8 different executions so the per-execution FIFO gate does not serialize
    // everything onto a single worker (each execution has its own causal chain
    // and can be drained independently).
    const rows = [] as Array<{ exec: string; ev: DomainEvent; rowId: string }>;
    for (let i = 0; i < 8; i++) {
      const exec = uuidFromHex(deterministicId([seed, "exec", i]));
      await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
      const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: i });
      const rowId = uuidFromHex(deterministicId([seed, "row", i]));
      await seedOutboxRow(exec, ev, 1, "PROCESSING", new Date(Date.now() - 600_000), rowId);
      rows.push({ exec, ev, rowId });
    }

    const busA = new WorkingBus();
    const busB = new WorkingBus();
    const dispatcherA = new OutboxDispatcher(new PersistedEventPublisher(store!, busA), busA, harness!.pg);
    const dispatcherB = new OutboxDispatcher(new PersistedEventPublisher(store!, busB), busB, harness!.pg);

    // Race the two dispatchers — `for update skip locked` must ensure each row
    // is reclaimed by exactly one worker.
    const [a, b] = await Promise.all([dispatcherA.drainAll(), dispatcherB.drainAll()]);

    expect(a + b).toBe(8);
    // Every seeded event was delivered by exactly one of the two buses.
    const publishedIds = new Set([
      ...busA.published.map((e) => e.id),
      ...busB.published.map((e) => e.id)
    ]);
    for (const r of rows) {
      expect(publishedIds.has(r.ev.id)).toBe(true);
    }
    // Total publish count equals total events (no duplicates across workers).
    expect(busA.published.length + busB.published.length).toBe(8);
    // Outbox is fully drained.
    const remaining = await harness!.pg.query(`select count(*)::int as n from event_outbox`);
    expect((remaining.rows[0] as { n: number }).n).toBe(0);
  });

  it("timeout boundary: a PROCESSING row whose visibility timeout has NOT elapsed is left alone (no premature reclaim)", async () => {
    const seed = suiteSeed("timeout-not-elapsed");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    // visible_after is 5 minutes in the FUTURE — another worker is still
    // actively processing this row. A second worker MUST NOT reclaim it.
    await seedOutboxRow(exec, ev, 1, "PROCESSING", new Date(Date.now() + 5 * 60_000),
      uuidFromHex(deterministicId([seed, "row"])));

    const bus = new WorkingBus();
    const dispatcher = new OutboxDispatcher(new PersistedEventPublisher(store!, bus), bus, harness!.pg);

    const delivered = await dispatcher.drainAll();

    expect(delivered).toBe(0);
    expect(bus.published).toHaveLength(0);
    const row = await harness!.pg.query(
      `select status from event_outbox where event_id = $1`,
      [ev.id]
    );
    // Row still PROCESSING, untouched.
    expect((row.rows[0] as { status: string }).status).toBe("PROCESSING");
  });

  it("timeout boundary: a PROCESSING row whose visibility timeout has JUST elapsed is reclaimed and the recovery marker is stamped", async () => {
    const seed = suiteSeed("timeout-elapsed");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    // visible_after just 1 second in the past — exactly the boundary case.
    await seedOutboxRow(exec, ev, 1, "PROCESSING", new Date(Date.now() - 1000),
      uuidFromHex(deterministicId([seed, "row"])));

    // Inspect last_error after the claim CTE flips status, before delivery
    // succeeds and the row is deleted. Use a bus that publishes synchronously
    // but lets us examine the row mid-flight by hooking the bus.
    let snapshotLastError: string | null = null;
    let snapshotRetryCount: number | null = null;
    const inspectingBus: EventBus = {
      published: [] as DomainEvent[],
      async publish(event: DomainEvent): Promise<void> {
        const r = await harness!.pg.query<{ last_error: string | null; retry_count: number }>(
          `select last_error, retry_count from event_outbox where event_id = $1`,
          [event.id]
        );
        if (r.rows[0]) {
          snapshotLastError = r.rows[0].last_error;
          snapshotRetryCount = Number(r.rows[0].retry_count);
        }
        (this as unknown as { published: DomainEvent[] }).published.push(event);
      },
      subscribe(): () => void { return () => { /* noop */ }; }
    } as EventBus & { published: DomainEvent[] };

    const dispatcher = new OutboxDispatcher(
      new PersistedEventPublisher(store!, inspectingBus),
      inspectingBus,
      harness!.pg
    );

    const delivered = await dispatcher.drainAll();
    expect(delivered).toBe(1);
    expect(snapshotLastError).toBe(STRANDED_RECOVERY_MARKER);
    expect(snapshotRetryCount).toBe(1); // reclaim bumped retry_count from 0 to 1
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until `check` returns true. Bounded so a regression that breaks the
 * claim path causes a test failure within a few seconds instead of hanging.
 */
async function waitFor(
  check: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}
