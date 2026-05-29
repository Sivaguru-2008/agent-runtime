/**
 * Postgres-backed ExecutionRepository.
 *
 * Replaces InMemoryExecutionRepository so executions survive restart. Without
 * this, a worker crash mid-task left scheduler/recovery code reading from an
 * empty Map, the execution would be silently dropped, and the lease/event
 * trail in Postgres pointed to an aggregate the API process no longer knew
 * about.
 *
 * Schema mapping (apps/api/db/schema.sql `executions`):
 *   id                    ←→ Execution.id                  (uuid)
 *   agent_id              ←→ Execution.agentId
 *   parent_execution_id   ←→ Execution.parentExecutionId
 *   status                ←→ Execution.status              (ExecutionStatus enum)
 *   input                 ←→ Execution.input               (jsonb)
 *   output                ←→ Execution.output              (jsonb, nullable)
 *   failure               ←→ Execution.failure             (jsonb, nullable)
 *   token_usage           ←→ Execution.tokenUsage          (jsonb)
 *   started_at            ←→ Execution.startedAt
 *   completed_at          ←→ Execution.completedAt         (nullable)
 *   updated_at            ←→ Execution.updatedAt
 *
 * Idempotency:
 *   ExecutionEngine.execute() saves three times per task (QUEUED → RUNNING →
 *   COMPLETED/FAILED). ON CONFLICT (id) DO UPDATE handles the lifecycle in
 *   place. The conflict target is the primary key, so this is a single-row
 *   atomic upsert with no extra locking.
 */

import type { Execution } from "../../../domain/model.js";
import type { ExecutionRepository, CommitTerminalInput, CommitTransitionInput } from "../../../domain/ports.js";
import type { FencingToken, FencedWriteOutcome } from "../../../domain/clusterPorts.js";
import type { PgClient } from "./pgClient.js";
import { deriveEventLinks } from "../eventLinkage.js";
import { isValidUuid, generateDeterministicUuid, createId } from "../../../shared/id.js";
import { FencingViolationError } from "../../../runtime/executionEngine.js";
import { assertTransition } from "../../../runtime/canonicalSemantics.js";
import type { DomainEvent } from "../../../domain/events.js";


interface ExecutionRow {
  id: string;
  agent_id: string;
  parent_execution_id: string | null;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  failure: Execution["failure"] | null;
  token_usage: Execution["tokenUsage"];
  started_at: Date | string;
  completed_at: Date | string | null;
  updated_at: Date | string;
  tenant_id?: string | null;
}

export class PostgresExecutionRepository implements ExecutionRepository {
  constructor(private readonly db: PgClient) {}

  async save(execution: Execution, fence?: FencingToken): Promise<void> {
    if (fence) {
      const outcome = await this.saveFenced(execution, fence);
      if (outcome === "FENCED") {
        throw new FencingViolationError(execution.id, fence.workerId);
      }
      return;
    }

    const isLeasedState = execution.status !== "CREATION" && execution.status !== "SCHEDULING" && execution.status !== "QUEUED";
    if (isLeasedState) {
      const { rows } = await this.db.query(
        `select 1 from execution_leases 
          where execution_id = $1 
            and status in ('LEASED', 'RENEWING', 'RECOVERY_OWNED')
            and expires_at > now()`,
        [execution.id]
      );
      if (rows.length > 0) {
        throw new FencingViolationError(execution.id, "unknown-unfenced-active-lease");
      }
    }
    // C-1 fail-closed: every execution row must carry an explicit tenant_id.
    // AgentRuntime.runTask stamps it from the authenticated request context;
    // the scheduler/recovery path threads the same tenant through the
    // execution snapshot. A missing value here would otherwise be silently
    // coerced to the schema DEFAULT 'system' and become invisible to the
    // owning tenant's reads (and visible to every other tenant via tenant
    // guard fall-through).
    const tenantId = assertTenantId(execution.tenantId, "executions", execution.id);
    await this.db.query(
      `insert into executions (
         id, agent_id, parent_execution_id, status, input, output, failure,
         token_usage, started_at, completed_at, updated_at, tenant_id
       ) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12)
       on conflict (id) do update set
         status              = excluded.status,
         output              = excluded.output,
         failure             = excluded.failure,
         token_usage         = excluded.token_usage,
         completed_at        = excluded.completed_at,
         updated_at          = excluded.updated_at,
         tenant_id           = excluded.tenant_id`,
      [
        execution.id,
        execution.agentId,
        execution.parentExecutionId ?? null,
        execution.status,
        JSON.stringify(execution.input),
        execution.output == null ? null : JSON.stringify(execution.output),
        execution.failure == null ? null : JSON.stringify(execution.failure),
        JSON.stringify(execution.tokenUsage),
        execution.startedAt,
        execution.completedAt ?? null,
        execution.updatedAt,
        tenantId
      ]
    );
  }

  /**
   * Fence-guarded upsert. Closes the TOCTOU between an advisory
   * `validateFencing()` SELECT and an unconditional `save()` UPSERT.
   *
   * Pattern: a CTE `fence` selects the lease row with `FOR UPDATE`, locking
   * it for the duration of the surrounding statement. The INSERT then
   * `SELECT FROM fence` — if the fence is empty (lease reclaimed/expired/
   * transferred), the SELECT returns zero rows and no INSERT (and no ON
   * CONFLICT UPDATE) runs.
   *
   * Why FOR UPDATE matters:
   *   Without it, a concurrent reclaim transaction can commit between the
   *   CTE evaluation and the conflict-update — and the UPDATE would land
   *   with a token that was valid at SELECT time but stale at COMMIT time.
   *   FOR UPDATE forces the reclaim to wait for our statement to finish,
   *   so the fence is consistent with the write.
   *
   * Why we also bound by expires_at:
   *   The validateFencing helper already enforces this; we do the same here
   *   so callers cannot accidentally land a write on a lease whose TTL
   *   passed in the gap before the heartbeat could renew.
   *
   * Returns "COMMITTED" if RETURNING produces 1 row, "FENCED" otherwise.
   */
  async saveFenced(execution: Execution, fence: FencingToken): Promise<FencedWriteOutcome> {
    const tenantId = assertTenantId(execution.tenantId, "executions", execution.id);
    const nowIso = new Date().toISOString();
    const { rows } = await this.db.query<{ id: string }>(
      `with fence as (
         select 1 as ok
           from execution_leases
          where execution_id = $13
            and (worker_id    = $14 and coalesce(worker_identity, worker_id) = $14)
            and (attempt      = $15
                 and coalesce(fencing_token, attempt)     = $15
                 and coalesce(lease_epoch, attempt)       = $15
                 and coalesce(ownership_version, attempt) = $15)
            and (
              $17::text is null
              or lease_id is null
              or lease_id = $17
            )
            and (
              ((status = 'LEASED' or status = 'RENEWING') and expires_at > $16)
              or (status = 'RECOVERY_OWNED' and expires_at > $16 and $18 = 'RECOVERING')
            )
          for update
       )
       insert into executions (
         id, agent_id, parent_execution_id, status, input, output, failure,
         token_usage, started_at, completed_at, updated_at, tenant_id
       )
       select $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12
       from fence
       on conflict (id) do update set
         status       = excluded.status,
         output       = excluded.output,
         failure      = excluded.failure,
         token_usage  = excluded.token_usage,
         completed_at = excluded.completed_at,
         updated_at   = excluded.updated_at,
         tenant_id    = excluded.tenant_id
       returning id`,
      [
        execution.id,
        execution.agentId,
        execution.parentExecutionId ?? null,
        execution.status,
        JSON.stringify(execution.input),
        execution.output == null ? null : JSON.stringify(execution.output),
        execution.failure == null ? null : JSON.stringify(execution.failure),
        JSON.stringify(execution.tokenUsage),
        execution.startedAt,
        execution.completedAt ?? null,
        execution.updatedAt,
        tenantId,
        fence.executionId,
        fence.workerId,
        fence.attempt,
        nowIso,
        fence.leaseId,
        execution.status
      ]
    );
    return rows.length === 1 ? "COMMITTED" : "FENCED";
  }

  async getById(id: string): Promise<Execution | undefined> {
    const { rows } = await this.db.query<ExecutionRow>(
      `select id, agent_id, parent_execution_id, status, input, output, failure,
              token_usage, started_at, completed_at, updated_at, tenant_id
         from executions where id = $1`,
      [id]
    );
    return rows[0] ? rowToExecution(rows[0]) : undefined;
  }

  async listByAgent(agentId: string): Promise<Execution[]> {
    const { rows } = await this.db.query<ExecutionRow>(
      `select id, agent_id, parent_execution_id, status, input, output, failure,
              token_usage, started_at, completed_at, updated_at, tenant_id
         from executions
         where agent_id = $1
         order by started_at desc`,
      [agentId]
    );
    return rows.map(rowToExecution);
  }

  async commitTerminal(input: CommitTerminalInput): Promise<FencedWriteOutcome> {
    return this.commitTransition({
      execution: input.execution,
      events: [input.event],
      memoryRecord: input.memoryRecord,
      checkpoint: input.checkpoint && input.checkpointSequence !== undefined ? {
        phase: input.execution.status === "COMPLETED" ? "COMPLETION" : "PLANNING",
        sequence: input.checkpointSequence,
        state: input.checkpoint
      } : undefined,
      fence: input.fence
    });
  }

  private validateRepositoryTransition(executionId: string, from: any, to: any): void {
    if (from === to) return;
    const terminalFrom = from === "COMPLETED" || from === "FAILED" || from === "DEAD_LETTERED" || from === "CANCELLED";
    const terminalTo = to === "COMPLETED" || to === "FAILED" || to === "DEAD_LETTERED" || to === "CANCELLED";
    if (terminalFrom) {
      if (from === "FAILED" && (to === "LEASE_ACQUISITION" || to === "DEAD_LETTERED")) {
        return;
      }
      throw new Error(`Illegal execution state transition out of terminal state: '${from}' -> '${to}' for execution '${executionId}'`);
    }
    if (terminalTo) {
      return;
    }
    assertTransition(executionId, from, to);
  }

  async commitTransition(input: CommitTransitionInput): Promise<FencedWriteOutcome> {
    const execution = input.execution;
    const tenantId = assertTenantId(execution.tenantId, "executions", execution.id);
    const nowIso = new Date().toISOString();

    return this.db.withTransaction(async (tx) => {
      // 1. Fencing lease lock & validation
      if (input.fence) {
        const { rows: fenceRows } = await tx.query(
          `select attempt 
             from execution_leases
            where execution_id = $1
              and (worker_id    = $2 and coalesce(worker_identity, worker_id) = $2)
              and (attempt      = $3
                   and coalesce(fencing_token, attempt)     = $3
                   and coalesce(lease_epoch, attempt)       = $3
                   and coalesce(ownership_version, attempt) = $3)
              and (
                $5::text is null
                or lease_id is null
                or lease_id = $5
              )
              and status in ('LEASED', 'RENEWING', 'RECOVERY_OWNED')
              and expires_at   > $4
            for update`,
          [
            input.fence.executionId,
            input.fence.workerId,
            input.fence.attempt,
            nowIso,
            input.fence.leaseId
          ]
        );
        if (fenceRows.length === 0) {
          return "FENCED";
        }
      }

      // Transactional Validation Hook: Repository Write Status Transition
      const { rows: existingRows } = await tx.query<{ status: string }>(
        `select status from executions where id = $1`,
        [execution.id]
      );
      if (existingRows[0]) {
        const from = existingRows[0].status as any;
        const to = execution.status;
        if (from !== to) {
          this.validateRepositoryTransition(execution.id, from, to);
        }
      }

      // 2. Update executions row
      await tx.query(
        `insert into executions (
           id, agent_id, parent_execution_id, status, input, output, failure,
           token_usage, started_at, completed_at, updated_at, tenant_id
         ) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12)
         on conflict (id) do update set
           status              = excluded.status,
           output              = excluded.output,
           failure             = excluded.failure,
           token_usage         = excluded.token_usage,
           completed_at        = excluded.completed_at,
           updated_at          = excluded.updated_at,
           tenant_id           = excluded.tenant_id`,
        [
          execution.id,
          execution.agentId,
          execution.parentExecutionId ?? null,
          execution.status,
          JSON.stringify(execution.input),
          execution.output == null ? null : JSON.stringify(execution.output),
          execution.failure == null ? null : JSON.stringify(execution.failure),
          JSON.stringify(execution.tokenUsage),
          execution.startedAt,
          execution.completedAt ?? null,
          execution.updatedAt,
          tenantId
        ]
      );

      // 3. Insert memory record if provided
      if (input.memoryRecord) {
        const rec = input.memoryRecord;
        const memoryTenantId = assertTenantId(rec.tenantId, "memory_records", rec.id);
        await tx.query(
          `insert into memory_records (
             id, agent_id, execution_id, type, content, metadata, created_at, updated_at, tenant_id
           ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$7,$8)
           on conflict (id) do update set
             content    = excluded.content,
             metadata   = excluded.metadata,
             updated_at = excluded.created_at,
             tenant_id  = excluded.tenant_id`,
          [
            rec.id,
            rec.agentId,
            rec.executionId ?? null,
            rec.type,
            rec.content,
            JSON.stringify(rec.metadata ?? {}),
            rec.createdAt,
            memoryTenantId
          ]
        );
      }

      // 4. Save events to event store and event outbox
      if (input.events && input.events.length > 0) {
        for (const event of input.events) {
          // Transactional Validation Hook: Outbox Commit Event Properties
          assertTenantId(event.metadata?.tenantId ?? execution.tenantId, "events", event.id);

          const mappedAggregateId = isValidUuid(event.aggregateId)
            ? event.aggregateId
            : generateDeterministicUuid(event.aggregateId);

          const eventResult = await tx.query<{ sequence: string }>(
            `insert into events (id, type, aggregate_id, aggregate_type, version, timestamp, payload, metadata, idempotency_key)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (idempotency_key) do nothing
             returning sequence`,
            [
              event.id,
              event.type,
              mappedAggregateId,
              event.aggregateType,
              event.version,
              event.timestamp,
              JSON.stringify(event.payload),
              JSON.stringify(event.metadata),
              event.metadata.idempotencyKey
            ]
          );

          let sequence: number;
          if (eventResult.rows.length === 0) {
            const existing = await tx.query<{ sequence: string }>(
              `select sequence from events where idempotency_key = $1`,
              [event.metadata.idempotencyKey]
            );
            sequence = Number(existing.rows[0]?.sequence ?? 0);
          } else {
            sequence = Number(eventResult.rows[0]?.sequence ?? 0);
          }

          // Write execution and cognition event link tables
          const links = deriveEventLinks(event);
          for (const link of links.executions) {
            await tx.query(
              `insert into event_execution_links (event_sequence, execution_id, link_kind)
               values ($1, $2, $3)
               on conflict do nothing`,
              [sequence, link.executionId, link.kind]
            );
          }
          for (const cognitionId of links.cognitions) {
            await tx.query(
              `insert into event_cognition_links (event_sequence, cognition_id)
               values ($1, $2)
               on conflict do nothing`,
              [sequence, cognitionId]
            );
          }

          // Insert event into event_outbox
          const outboxId = createId();
          await tx.query(
            `insert into event_outbox (id, event_id, execution_id, event_type, payload, metadata, sequence, idempotency_key, original_timestamp)
             values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
             on conflict (idempotency_key) do nothing`,
            [
              outboxId,
              event.id,
              execution.id,
              event.type,
              JSON.stringify(event.payload),
              JSON.stringify(event.metadata),
              sequence,
              event.metadata.idempotencyKey,
              event.timestamp
            ]
          );
        }
      }

      // 5. Save checkpoint if present
      if (input.checkpoint) {
        const checkpointId = createId();
        await tx.query(
          `insert into execution_checkpoints (id, execution_id, worker_id, sequence, phase, state, created_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7)
           on conflict (execution_id, sequence) do update set
             phase      = excluded.phase,
             state      = excluded.state,
             created_at = excluded.created_at`,
          [
            checkpointId,
            execution.id,
            input.fence?.workerId ?? "local",
            input.checkpoint.sequence,
            input.checkpoint.phase,
            JSON.stringify(input.checkpoint.state),
            nowIso
          ]
        );
      }

      return "COMMITTED";
    });
  }

  async detectPartialCommit(executionId: string): Promise<{
    isConsistent: boolean;
    actualStatus: Execution["status"];
    lastEventSeq?: number;
    error?: string;
  }> {
    const execution = await this.getById(executionId);
    if (!execution) {
      return { isConsistent: true, actualStatus: "CREATION" };
    }

    // Get the last event type from events table linked to this execution
    const { rows: eventRows } = await this.db.query<{ type: string; sequence: string }>(
      `select e.type, e.sequence
         from events e
         join event_execution_links l on l.event_sequence = e.sequence
         where l.execution_id = $1
         order by e.sequence desc
         limit 1`,
      [executionId]
    );

    const lastEvent = eventRows[0];
    const actualStatus = execution.status;

    if (actualStatus === "COMPLETED") {
      if (!lastEvent || lastEvent.type !== "EXECUTION_COMPLETED") {
        return {
          isConsistent: false,
          actualStatus,
          lastEventSeq: lastEvent ? Number(lastEvent.sequence) : undefined,
          error: `Partial commit anomaly: execution is marked COMPLETED but last event in log is ${
            lastEvent ? lastEvent.type : "NONE"
          }`
        };
      }
    }

    if (actualStatus === "FAILED") {
      if (!lastEvent || lastEvent.type !== "EXECUTION_FAILED") {
        return {
          isConsistent: false,
          actualStatus,
          lastEventSeq: lastEvent ? Number(lastEvent.sequence) : undefined,
          error: `Partial commit anomaly: execution is marked FAILED but last event in log is ${
            lastEvent ? lastEvent.type : "NONE"
          }`
        };
      }
    }

    if (lastEvent) {
      if (lastEvent.type === "EXECUTION_COMPLETED" && actualStatus !== "COMPLETED") {
        return {
          isConsistent: false,
          actualStatus,
          lastEventSeq: Number(lastEvent.sequence),
          error: `Partial commit anomaly: event log terminates at EXECUTION_COMPLETED but execution status is ${actualStatus}`
        };
      }
      if (lastEvent.type === "EXECUTION_FAILED" && actualStatus !== "FAILED") {
        return {
          isConsistent: false,
          actualStatus,
          lastEventSeq: Number(lastEvent.sequence),
          error: `Partial commit anomaly: event log terminates at EXECUTION_FAILED but execution status is ${actualStatus}`
        };
      }
    }

    return {
      isConsistent: true,
      actualStatus,
      lastEventSeq: lastEvent ? Number(lastEvent.sequence) : undefined
    };
  }

  isOutboxEnabled(): boolean {
    return process.env.ENABLE_OUTBOX_DISPATCH !== "false" && process.env.ENABLE_OUTBOX_DISPATCH !== "0";
  }
}

function assertTenantId(value: string | undefined | null, table: string, resourceId: string): string {
  if (typeof value !== "string" || value.length === 0) {
    const err = new Error(
      `[tenant-isolation] refused to write ${table} row ${resourceId} without an explicit tenant_id`
    );
    (err as NodeJS.ErrnoException).code = "TENANT_ID_MISSING";
    throw err;
  }
  return value;
}

function rowToExecution(row: ExecutionRow): Execution {
  const tokenUsage = (row.token_usage ?? { prompt: 0, completion: 0, total: 0 }) as Execution["tokenUsage"];
  return {
    id: row.id,
    agentId: row.agent_id,
    parentExecutionId: row.parent_execution_id ?? undefined,
    status: row.status as Execution["status"],
    input: row.input,
    output: row.output ?? undefined,
    failure: row.failure ?? undefined,
    tokenUsage: {
      prompt: Number(tokenUsage.prompt ?? 0),
      completion: Number(tokenUsage.completion ?? 0),
      total: Number(tokenUsage.total ?? 0)
    },
    startedAt: toIso(row.started_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
    updatedAt: toIso(row.updated_at),
    tenantId: row.tenant_id ?? undefined
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
