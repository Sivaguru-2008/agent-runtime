/**
 * OutboxDlqRecoveryService — dead-letter recovery correctness suite.
 *
 * Guarantee under test: "every committed outbox event is eventually delivered."
 *
 * Failure mode this file characterizes (now FIXED):
 *   When OutboxDispatcher exhausted MAX_RETRIES it moved a row to
 *   event_outbox_dlq and deleted it from event_outbox. Nothing ever read the
 *   DLQ back out, so any event whose delivery failed long enough to exhaust the
 *   retry ladder (e.g. a sustained bus outage) was permanently dropped off the
 *   bus — the delivery guarantee was silently broken for exactly the events
 *   that needed recovery most.
 *
 * Fix shipped in this commit:
 *   OutboxDlqRecoveryService runs an out-of-band sweep that claims eligible DLQ
 *   rows (`for update skip locked`), re-attempts delivery directly to the bus,
 *   deletes on success, applies durable bounded backoff on failure, and
 *   quarantines genuinely-poison rows. Redelivery is idempotent (consumers
 *   dedupe on idempotency_key) and fenced (only the active region drains).
 *
 * These tests assert the CORRECT behavior — they fail if recovery regresses.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "../../../src/infrastructure/persistence/postgresEventStore.js";
import {
  OutboxDlqRecoveryService,
  DLQ_QUARANTINE_MARKER
} from "../../../src/infrastructure/events/outboxDlqRecoveryService.js";
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

/** Bus whose publish always throws — models a sustained downstream outage. */
class ThrowingBus implements EventBus {
  attempts = 0;
  async publish(): Promise<void> {
    this.attempts += 1;
    throw new Error("bus still down");
  }
  subscribe(): () => void {
    return () => { /* noop */ };
  }
}

interface SeedDlqOpts {
  recoveryAttempts?: number;
  recoveryVisibleAfter?: Date;
  quarantined?: boolean;
  originalTimestamp?: string | null;
}

async function seedDlqRow(
  exec: string,
  ev: DomainEvent,
  seq: number,
  rowId: string,
  opts: SeedDlqOpts = {}
): Promise<void> {
  await harness!.pg.query(
    `insert into event_outbox_dlq
       (id, event_id, execution_id, event_type, payload, metadata, sequence, idempotency_key,
        failed_at, last_error, original_timestamp, recovery_attempts, recovery_visible_after, quarantined)
     values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      rowId,
      ev.id,
      exec,
      ev.type,
      JSON.stringify(ev.payload),
      JSON.stringify(ev.metadata),
      seq,
      ev.metadata.idempotencyKey,
      new Date(Date.now() - 600_000).toISOString(),
      "MAX_RETRIES_EXCEEDED",
      opts.originalTimestamp === undefined ? ev.timestamp : opts.originalTimestamp,
      opts.recoveryAttempts ?? 0,
      (opts.recoveryVisibleAfter ?? new Date(Date.now() - 1000)).toISOString(),
      opts.quarantined ?? false
    ]
  );
}

describe.skipIf(!harness)("OutboxDlqRecoveryService — redelivers dead-lettered events", () => {
  it("redelivers a dead-lettered event and removes it from the DLQ", async () => {
    const seed = suiteSeed("dlq-redeliver");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    await seedDlqRow(exec, ev, 1, uuidFromHex(deterministicId([seed, "row"])));

    const bus = new WorkingBus();
    const svc = new OutboxDlqRecoveryService(new PersistedEventPublisher(store!, bus), bus, harness!.pg);

    const redelivered = await svc.drainAll();

    expect(redelivered).toBe(1);
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].id).toBe(ev.id);
    const rows = await harness!.pg.query(`select * from event_outbox_dlq where event_id = $1`, [ev.id]);
    expect(rows.rows).toHaveLength(0); // deleted on success
  });

  it("preserves the producer-side original_timestamp on the redelivered bus event", async () => {
    const seed = suiteSeed("dlq-timestamp");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    await seedDlqRow(exec, ev, 1, uuidFromHex(deterministicId([seed, "row"])), {
      originalTimestamp: ev.timestamp
    });

    const bus = new WorkingBus();
    const svc = new OutboxDlqRecoveryService(new PersistedEventPublisher(store!, bus), bus, harness!.pg);

    await svc.drainAll();
    expect(bus.published).toHaveLength(1);
    // Redelivered with the ORIGINAL timestamp, not the recovery wall-clock.
    expect(bus.published[0].timestamp).toBe(ev.timestamp);
  });

  it("leaves rows whose backoff window has NOT elapsed untouched (no premature retry)", async () => {
    const seed = suiteSeed("dlq-not-eligible");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    // Visible 5 minutes in the FUTURE — its backoff window has not elapsed.
    await seedDlqRow(exec, ev, 1, uuidFromHex(deterministicId([seed, "row"])), {
      recoveryVisibleAfter: new Date(Date.now() + 5 * 60_000)
    });

    const bus = new WorkingBus();
    const svc = new OutboxDlqRecoveryService(new PersistedEventPublisher(store!, bus), bus, harness!.pg);

    const redelivered = await svc.drainAll();
    expect(redelivered).toBe(0);
    expect(bus.published).toHaveLength(0);
    const rows = await harness!.pg.query(`select 1 from event_outbox_dlq where event_id = $1`, [ev.id]);
    expect(rows.rows).toHaveLength(1); // still present, untouched
  });

  it("ignores already-quarantined rows", async () => {
    const seed = suiteSeed("dlq-quarantined-skip");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    await seedDlqRow(exec, ev, 1, uuidFromHex(deterministicId([seed, "row"])), { quarantined: true });

    const bus = new WorkingBus();
    const svc = new OutboxDlqRecoveryService(new PersistedEventPublisher(store!, bus), bus, harness!.pg);

    const redelivered = await svc.drainAll();
    expect(redelivered).toBe(0);
    expect(bus.published).toHaveLength(0);
  });
});

describe.skipIf(!harness)("OutboxDlqRecoveryService — bounded retry + quarantine", () => {
  it("a failed redelivery bumps recovery_attempts and schedules a future backoff (no quarantine below ceiling)", async () => {
    const seed = suiteSeed("dlq-backoff");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    await seedDlqRow(exec, ev, 1, uuidFromHex(deterministicId([seed, "row"])));

    const bus = new ThrowingBus();
    // High ceiling so a single failure does NOT quarantine; tiny backoff so the
    // scheduled time is comfortably in the future but the test stays fast.
    const svc = new OutboxDlqRecoveryService(new PersistedEventPublisher(store!, bus), bus, harness!.pg, undefined, {
      maxAttempts: 5,
      baseBackoffMs: 60_000
    });

    const redelivered = await svc.tick();
    expect(redelivered).toBe(0);
    expect(bus.attempts).toBe(1);

    const row = await harness!.pg.query<{ recovery_attempts: number; quarantined: boolean; recovery_visible_after: Date; last_recovery_error: string }>(
      `select recovery_attempts, quarantined, recovery_visible_after, last_recovery_error
         from event_outbox_dlq where event_id = $1`,
      [ev.id]
    );
    expect(row.rows).toHaveLength(1);
    expect(Number(row.rows[0].recovery_attempts)).toBe(1);
    expect(row.rows[0].quarantined).toBe(false);
    expect(new Date(row.rows[0].recovery_visible_after).getTime()).toBeGreaterThan(Date.now());
    expect(row.rows[0].last_recovery_error).toContain("bus still down");
  });

  it("quarantines a row once recovery attempts are exhausted, stamping the marker", async () => {
    const seed = suiteSeed("dlq-quarantine");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    await seedDlqRow(exec, ev, 1, uuidFromHex(deterministicId([seed, "row"])));

    const bus = new ThrowingBus();
    // maxAttempts=1 → the first failure exhausts the ceiling and quarantines.
    const svc = new OutboxDlqRecoveryService(new PersistedEventPublisher(store!, bus), bus, harness!.pg, undefined, {
      maxAttempts: 1
    });

    await svc.tick();

    const row = await harness!.pg.query<{ recovery_attempts: number; quarantined: boolean; last_recovery_error: string }>(
      `select recovery_attempts, quarantined, last_recovery_error from event_outbox_dlq where event_id = $1`,
      [ev.id]
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].quarantined).toBe(true);
    expect(Number(row.rows[0].recovery_attempts)).toBe(1);
    expect(row.rows[0].last_recovery_error).toContain(DLQ_QUARANTINE_MARKER);

    // A subsequent sweep does not touch the quarantined row.
    const again = await svc.tick();
    expect(again).toBe(0);
  });
});

describe.skipIf(!harness)("OutboxDlqRecoveryService — concurrency + idempotency", () => {
  it("two recovery workers contending on the same DLQ rows deliver each event exactly once", async () => {
    const seed = suiteSeed("dlq-concurrent");
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    const rows: Array<{ ev: DomainEvent }> = [];
    for (let i = 0; i < 8; i++) {
      const exec = uuidFromHex(deterministicId([seed, "exec", i]));
      await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });
      const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: i });
      await seedDlqRow(exec, ev, 1, uuidFromHex(deterministicId([seed, "row", i])));
      rows.push({ ev });
    }

    const busA = new WorkingBus();
    const busB = new WorkingBus();
    const svcA = new OutboxDlqRecoveryService(new PersistedEventPublisher(store!, busA), busA, harness!.pg);
    const svcB = new OutboxDlqRecoveryService(new PersistedEventPublisher(store!, busB), busB, harness!.pg);

    const [a, b] = await Promise.all([svcA.drainAll(), svcB.drainAll()]);

    expect(a + b).toBe(8);
    expect(busA.published.length + busB.published.length).toBe(8);
    const publishedIds = new Set([...busA.published, ...busB.published].map((e) => e.id));
    for (const r of rows) expect(publishedIds.has(r.ev.id)).toBe(true);
    const remaining = await harness!.pg.query<{ n: number }>(`select count(*)::int as n from event_outbox_dlq`);
    expect(remaining.rows[0].n).toBe(0);
  });

  it("duplicate drainAll() calls are no-ops once the DLQ is drained (never re-publish)", async () => {
    const seed = suiteSeed("dlq-dup");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });
    await seedDlqRow(exec, ev, 1, uuidFromHex(deterministicId([seed, "row"])));

    const bus = new WorkingBus();
    const svc = new OutboxDlqRecoveryService(new PersistedEventPublisher(store!, bus), bus, harness!.pg);

    const first = await svc.drainAll();
    const second = await svc.drainAll();
    const third = await svc.drainAll();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(third).toBe(0);
    expect(bus.published).toHaveLength(1);
  });
});
