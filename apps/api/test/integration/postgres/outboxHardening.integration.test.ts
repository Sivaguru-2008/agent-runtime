import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PostgresExecutionRepository } from "../../../src/infrastructure/persistence/postgres/postgresExecutionRepository.js";
import { PostgresEventStore } from "../../../src/infrastructure/persistence/postgresEventStore.js";
import { OutboxDispatcher } from "../../../src/infrastructure/events/outboxDispatcher.js";
import { PersistedEventPublisher } from "../../../src/infrastructure/events/persistedEventPublisher.js";
import { tryStartHarness } from "./harness.js";
import {
  makeEvent,
  seedAgentAndExecution,
  suiteSeed,
  uuidFromHex
} from "./factories.js";
import { deterministicId } from "../../../src/shared/determinism.js";
import type { DomainEvent } from "../../../src/domain/events.js";
import type { Execution, MemoryRecord } from "../../../src/domain/model.js";
import type { EventBus, EventHandler } from "../../../src/domain/ports.js";

const harness = await tryStartHarness();
const repo = harness ? new PostgresExecutionRepository(harness.pg) : null;
const store = harness ? new PostgresEventStore(harness.connectionString) : null;

afterEach(async () => {
  if (harness) await harness.reset();
});

afterAll(async () => {
  if (store) await store.close();
  if (harness) await harness.stop();
});

class CapturingEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  private failPredicate: (e: DomainEvent) => boolean = () => false;
  private readonly handlers = new Set<EventHandler>();

  async publish(event: DomainEvent): Promise<void> {
    if (this.failPredicate(event)) {
      throw new Error("simulated transient bus outage");
    }
    this.published.push(event);
    await Promise.all([...this.handlers].map((h) => h(event)));
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  failWhen(predicate: (e: DomainEvent) => boolean): void {
    this.failPredicate = predicate;
  }

  recover(): void {
    this.failPredicate = () => false;
  }
}

describe.skipIf(!harness)("Postgres Outbox + Atomic Terminal Commit Hardening", () => {
  it("executes commitTerminal successfully on happy path", async () => {
    const seed = suiteSeed("happy-path");
    const execId = uuidFromHex(deterministicId([seed, "exec"]));
    const agentId = uuidFromHex(deterministicId([seed, "agent"]));
    const nowIso = new Date().toISOString();

    // 1. Seed base tables (Tenant tagged)
    await seedAgentAndExecution(harness!.pg, { agentId, executionId: execId });

    // 2. Prepare mock active lease in Postgres
    await harness!.pg.query(
      `insert into execution_leases (execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt)
       values ($1, 'w1', $2, $2, $3, 'ACTIVE', 1)`,
      [execId, nowIso, new Date(Date.now() + 60000).toISOString()]
    );

    const completed: Execution = {
      id: execId,
      agentId,
      status: "COMPLETED",
      input: { prompt: "test" },
      output: { ok: true },
      tokenUsage: { prompt: 10, completion: 5, total: 15 },
      startedAt: nowIso,
      completedAt: nowIso,
      updatedAt: nowIso,
      tenantId: "system"
    };

    const terminalEvent = makeEvent({
      type: "EXECUTION_COMPLETED",
      executionId: execId,
      seed,
      step: 0,
      payloadExtras: { execution: completed }
    });

    const memoryRecord: MemoryRecord = {
      id: uuidFromHex(deterministicId([seed, "mem"])),
      agentId,
      executionId: execId,
      type: "TASK_HISTORY",
      content: "Task completed successfully",
      metadata: { score: 1 },
      createdAt: nowIso,
      tenantId: "system"
    };

    // 3. Execute atomic terminal commit transaction
    const outcome = await repo!.commitTerminal({
      execution: completed,
      event: terminalEvent,
      memoryRecord,
      checkpoint: { status: "COMPLETED" },
      checkpointSequence: 1,
      fence: { executionId: execId, workerId: "w1", attempt: 1 }
    });

    expect(outcome).toBe("COMMITTED");

    // 4. Verify writes
    const execRow = await repo!.getById(execId);
    expect(execRow?.status).toBe("COMPLETED");
    expect(execRow?.tokenUsage.total).toBe(15);

    const outboxRows = await harness!.pg.query(
      `select * from event_outbox where execution_id = $1`,
      [execId]
    );
    expect(outboxRows.rows).toHaveLength(1);
    expect((outboxRows.rows[0] as any).event_type).toBe("EXECUTION_COMPLETED");
    expect((outboxRows.rows[0] as any).status).toBe("PENDING");

    const memRows = await harness!.pg.query(
      `select * from memory_records where execution_id = $1`,
      [execId]
    );
    expect(memRows.rows).toHaveLength(1);
    expect((memRows.rows[0] as any).tenant_id).toBe("system");

    const checkpointRows = await harness!.pg.query(
      `select * from execution_checkpoints where execution_id = $1`,
      [execId]
    );
    expect(checkpointRows.rows).toHaveLength(1);
    expect((checkpointRows.rows[0] as any).sequence).toBe("1");
  });

  it("rejects commitTerminal with FENCED if lease fencing token is stale", async () => {
    const seed = suiteSeed("fencing-fail");
    const execId = uuidFromHex(deterministicId([seed, "exec"]));
    const agentId = uuidFromHex(deterministicId([seed, "agent"]));
    const nowIso = new Date().toISOString();

    await seedAgentAndExecution(harness!.pg, { agentId, executionId: execId });

    // Fence has attempt = 2 in DB, but worker uses attempt = 1 (stale)
    await harness!.pg.query(
      `insert into execution_leases (execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt)
       values ($1, 'w1', $2, $2, $3, 'ACTIVE', 2)`,
      [execId, nowIso, new Date(Date.now() + 60000).toISOString()]
    );

    const completed: Execution = {
      id: execId,
      agentId,
      status: "COMPLETED",
      input: { prompt: "test" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: nowIso,
      updatedAt: nowIso,
      tenantId: "system"
    };

    const terminalEvent = makeEvent({
      type: "EXECUTION_COMPLETED",
      executionId: execId,
      seed,
      step: 0,
      payloadExtras: { execution: completed }
    });

    const outcome = await repo!.commitTerminal({
      execution: completed,
      event: terminalEvent,
      fence: { executionId: execId, workerId: "w1", attempt: 1 } // Stale attempt token
    });

    expect(outcome).toBe("FENCED");

    // DB state must be untouched (retains seeded values)
    const execRow = await repo!.getById(execId);
    expect(execRow?.status).toBe("COMPLETED"); // seeded value was COMPLETED in factory
    const outboxRows = await harness!.pg.query(
      `select * from event_outbox where execution_id = $1`,
      [execId]
    );
    expect(outboxRows.rows).toHaveLength(0);
  });

  it("rolls back fully on db errors (transaction atomic integrity)", async () => {
    const seed = suiteSeed("rollback");
    const execId = uuidFromHex(deterministicId([seed, "exec"]));
    const agentId = uuidFromHex(deterministicId([seed, "agent"]));
    const nowIso = new Date().toISOString();

    await seedAgentAndExecution(harness!.pg, { agentId, executionId: execId });

    // Seed lease
    await harness!.pg.query(
      `insert into execution_leases (execution_id, worker_id, acquired_at, renewed_at, expires_at, status, attempt)
       values ($1, 'w1', $2, $2, $3, 'ACTIVE', 1)`,
      [execId, nowIso, new Date(Date.now() + 60000).toISOString()]
    );

    const completed: Execution = {
      id: execId,
      agentId,
      status: "COMPLETED",
      input: { prompt: "test" },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      startedAt: nowIso,
      updatedAt: nowIso,
      tenantId: "system"
    };

    const terminalEvent = makeEvent({
      type: "EXECUTION_COMPLETED",
      executionId: execId,
      seed,
      step: 0,
      payloadExtras: { execution: completed }
    });

    // Provide a corrupt/missing tenant ID memory record to force constraint failure
    const badMemoryRecord: MemoryRecord = {
      id: uuidFromHex(deterministicId([seed, "mem"])),
      agentId,
      executionId: execId,
      type: "TASK_HISTORY",
      content: "trigger rollback",
      metadata: {},
      createdAt: nowIso,
      tenantId: "" // Missing tenant_id triggers assertTenantId validation error!
    };

    await expect(
      repo!.commitTerminal({
        execution: completed,
        event: terminalEvent,
        memoryRecord: badMemoryRecord,
        fence: { executionId: execId, workerId: "w1", attempt: 1 }
      })
    ).rejects.toThrow();

    // Verify complete rollback: event_outbox is empty and no memory record created!
    const outboxRows = await harness!.pg.query(
      `select * from event_outbox where execution_id = $1`,
      [execId]
    );
    expect(outboxRows.rows).toHaveLength(0);

    const memRows = await harness!.pg.query(
      `select * from memory_records where execution_id = $1`,
      [execId]
    );
    expect(memRows.rows).toHaveLength(0);
  });

  it("preserves strict per-execution causal ordering under dispatcher backoffs", async () => {
    const seed = suiteSeed("ordering");
    const execA = uuidFromHex(deterministicId([seed, "exec-A"]));
    const execB = uuidFromHex(deterministicId([seed, "exec-B"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));

    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: execA });
    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: execB });

    const bus = new CapturingEventBus();
    const publisher = new PersistedEventPublisher(store!, bus);
    const dispatcher = new OutboxDispatcher(publisher, bus, harness!.pg);

    const evA1 = makeEvent({ type: "EXECUTION_STEP_STARTED", executionId: execA, seed, step: 0 });
    const evA2 = makeEvent({ type: "EXECUTION_STEP_COMPLETED", executionId: execA, seed, step: 1 });
    const evB1 = makeEvent({ type: "EXECUTION_STEP_STARTED", executionId: execB, seed, step: 2 });
    const evB2 = makeEvent({ type: "EXECUTION_STEP_COMPLETED", executionId: execB, seed, step: 3 });

    // Seed directly to event_outbox (ordered)
    const eventsToSeed = [
      { id: uuidFromHex(deterministicId([seed, "outbox-A1"])), ev: evA1, exec: execA, seq: 1 },
      { id: uuidFromHex(deterministicId([seed, "outbox-A2"])), ev: evA2, exec: execA, seq: 2 },
      { id: uuidFromHex(deterministicId([seed, "outbox-B1"])), ev: evB1, exec: execB, seq: 3 },
      { id: uuidFromHex(deterministicId([seed, "outbox-B2"])), ev: evB2, exec: execB, seq: 4 }
    ];

    for (const item of eventsToSeed) {
      await harness!.pg.query(
        `insert into events (id, type, aggregate_id, aggregate_type, version, timestamp, payload, metadata, idempotency_key)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
         on conflict do nothing`,
        [
          item.ev.id,
          item.ev.type,
          item.ev.aggregateId,
          item.ev.aggregateType,
          item.ev.version,
          item.ev.timestamp,
          JSON.stringify(item.ev.payload),
          JSON.stringify(item.ev.metadata),
          item.ev.metadata.idempotencyKey
        ]
      );
      await harness!.pg.query(
        `insert into event_outbox (id, event_id, execution_id, event_type, payload, metadata, sequence, idempotency_key)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
        [
          item.id,
          item.ev.id,
          item.exec,
          item.ev.type,
          JSON.stringify(item.ev.payload),
          JSON.stringify(item.ev.metadata),
          item.seq,
          item.ev.metadata.idempotencyKey
        ]
      );
    }

    // Outage: event bus throws ONLY for Execution A's first event (evA1)
    bus.failWhen((e) => e.id === evA1.id);

    // Run first tick (attempts evA1 and evB1, evA1 fails and enters backoff, evB1 succeeds)
    const count1 = await dispatcher.tick(4);
    expect(count1).toBe(1); // Only evB1 successfully dispatched

    // Verify evA1 is in PENDING retry status, and evB1 is deleted
    const outboxA1 = await harness!.pg.query(`select * from event_outbox where event_id = $1`, [evA1.id]);
    expect((outboxA1.rows[0] as any).status).toBe("PENDING");
    expect(Number((outboxA1.rows[0] as any).retry_count)).toBe(1);

    const outboxB1 = await harness!.pg.query(`select * from event_outbox where event_id = $1`, [evB1.id]);
    expect(outboxB1.rows).toHaveLength(0);

    // Crucial Check: evA2 is completely unblocked in theory BUT because evA1 is in PENDING retry,
    // tick MUST NOT dispatch evA2! This is strict FIFO ordering.
    // Meanwhile, evB2 is unblocked and should proceed!
    const count2 = await dispatcher.tick(4);
    expect(count2).toBe(1); // Only evB2 successfully dispatched! evA2 stays queued.

    const outboxA2 = await harness!.pg.query(`select * from event_outbox where event_id = $1`, [evA2.id]);
    expect(outboxA2.rows).toHaveLength(1);
    expect((outboxA2.rows[0] as any).status).toBe("PENDING"); // Un-dispatched!

    const outboxB2 = await harness!.pg.query(`select * from event_outbox where event_id = $1`, [evB2.id]);
    expect(outboxB2.rows).toHaveLength(0); // evB2 successfully dispatched!
  });

  it("promotes poison events to event_outbox_dlq after max retries", async () => {
    const seed = suiteSeed("poison-dlq");
    const exec = uuidFromHex(deterministicId([seed, "exec"]));
    const agent = uuidFromHex(deterministicId([seed, "agent"]));

    await seedAgentAndExecution(harness!.pg, { agentId: agent, executionId: exec });

    const bus = new CapturingEventBus();
    const publisher = new PersistedEventPublisher(store!, bus);
    const dispatcher = new OutboxDispatcher(publisher, bus, harness!.pg);

    const ev = makeEvent({ type: "EXECUTION_COMPLETED", executionId: exec, seed, step: 0 });

    await harness!.pg.query(
      `insert into events (id, type, aggregate_id, aggregate_type, version, timestamp, payload, metadata, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       on conflict do nothing`,
      [
        ev.id,
        ev.type,
        ev.aggregateId,
        ev.aggregateType,
        ev.version,
        ev.timestamp,
        JSON.stringify(ev.payload),
        JSON.stringify(ev.metadata),
        ev.metadata.idempotencyKey
      ]
    );

    // Insert directly into outbox with retry_count = 5 (at MAX_RETRIES limit)
    await harness!.pg.query(
      `insert into event_outbox (id, event_id, execution_id, event_type, payload, metadata, sequence, idempotency_key, retry_count)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 1, $7, 5)`,
      [
        uuidFromHex(deterministicId([seed, "outbox-poison"])),
        ev.id,
        exec,
        ev.type,
        JSON.stringify(ev.payload),
        JSON.stringify(ev.metadata),
        ev.metadata.idempotencyKey
      ]
    );

    // Make the bus throw to force failure
    bus.failWhen(() => true);

    // Dispatcher tick
    const count = await dispatcher.tick();
    expect(count).toBe(0); // delivery fails

    // Verify event is deleted from event_outbox
    const outboxRows = await harness!.pg.query(`select * from event_outbox where event_id = $1`, [ev.id]);
    expect(outboxRows.rows).toHaveLength(0);

    // Verify event is written to event_outbox_dlq
    const dlqRows = await harness!.pg.query(`select * from event_outbox_dlq where event_id = $1`, [ev.id]);
    expect(dlqRows.rows).toHaveLength(1);
    expect((dlqRows.rows[0] as any).last_error).toContain("simulated transient bus outage");
  });
});
