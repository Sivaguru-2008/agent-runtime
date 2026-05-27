/**
 * Postgres-backed Dead-Letter Queue.
 *
 * Production risk solved:
 *   The InMemoryDeadLetterStore (development default) loses all poisoned-execution
 *   entries on process restart. In production, operators need durable DLQ records
 *   to perform post-incident root-cause analysis, decide which executions to
 *   replay after a bug fix, and produce SLA violation reports.
 *
 * Upsert semantics:
 *   Multiple workers may push the same executionId if a race occurs between
 *   the recovery loop and a worker completing its last attempt. The upsert
 *   ensures idempotency: last write wins on the error/attempt fields.
 *
 * Operational safety:
 *   Resolved entries (resolved_at IS NOT NULL) are retained for 180 days
 *   per the retention policy. This preserves audit evidence for incidents
 *   without allowing the table to grow unboundedly.
 *
 * Scaling implications:
 *   DLQ is a low-write, low-read table. Even at 1000 poison-pills/day it
 *   accumulates only ~365 000 rows/year — well within Postgres range without
 *   partitioning. If throughput is higher, add a BRIN index on moved_at.
 */

import type { PgClient } from "../persistence/postgres/pgClient.js";
import type { DeadLetterEntry } from "../../domain/cluster.js";
import type { DeadLetterQueue } from "../../domain/clusterPorts.js";
import { createId } from "../../shared/id.js";

export class PostgresDeadLetterStore implements DeadLetterQueue {
  constructor(private readonly db: PgClient) {}

  async push(entry: DeadLetterEntry): Promise<void> {
    await this.db.query(
      `insert into execution_dead_letters
         (execution_id, worker_id, tenant_id, attempt, error, context, moved_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (execution_id) do update set
         worker_id  = excluded.worker_id,
         attempt    = excluded.attempt,
         error      = excluded.error,
         context    = excluded.context,
         moved_at   = excluded.moved_at,
         resolved_at = null,
         resolution  = null`,
      [
        entry.executionId,
        entry.workerId,
        "system", // tenant_id backfill — callers can extend this when tenantId is propagated
        entry.failureCount,
        JSON.stringify({ message: entry.lastError }),
        JSON.stringify({
          agentId: entry.agentId,
          firstFailedAt: entry.firstFailedAt,
          taskSnapshot: entry.taskSnapshot ?? null
        }),
        entry.movedAt
      ]
    );
  }

  async list(): Promise<DeadLetterEntry[]> {
    const { rows } = await this.db.query<{
      execution_id: string;
      worker_id: string | null;
      attempt: number;
      error: { message: string };
      context: { agentId: string; firstFailedAt: string; taskSnapshot?: Record<string, unknown> };
      moved_at: string;
    }>(
      `select execution_id, worker_id, attempt, error, context, moved_at
       from execution_dead_letters
       where resolved_at is null
       order by moved_at desc
       limit 1000`
    );
    return rows.map(this.toEntry);
  }

  async getByExecution(executionId: string): Promise<DeadLetterEntry | undefined> {
    const { rows } = await this.db.query<{
      execution_id: string;
      worker_id: string | null;
      attempt: number;
      error: { message: string };
      context: { agentId: string; firstFailedAt: string; taskSnapshot?: Record<string, unknown> };
      moved_at: string;
    }>(
      `select execution_id, worker_id, attempt, error, context, moved_at
       from execution_dead_letters where execution_id = $1`,
      [executionId]
    );
    if (!rows.length) return undefined;
    return this.toEntry(rows[0]!);
  }

  /**
   * Mark a DLQ entry as resolved — called after an operator manually triggers
   * a replay or explicitly discards the entry.
   *
   * Correctness logic:
   *   Overwriting prior state is unsafe because it leaves no trace of the
   *   remediation lineage or prior operator attempts. Instead, we insert a
   *   record into the append-only `dlq_remediation_actions` audit log table
   *   and then execute the projection update to `execution_dead_letters` inside
   *   the same transaction. This preserves existing DLQ readers while enforcing
   *   a complete forensic history.
   */
  async resolve(executionId: string, resolution: string, operatorIdentity = "system"): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      // 1. Fetch prior resolution state (for audit)
      const { rows: priorRows } = await tx.query<{ resolved_at: Date | string | null; resolution: string | null }>(
        `select resolved_at, resolution from execution_dead_letters where execution_id = $1`,
        [executionId]
      );
      
      const priorState = priorRows[0] 
        ? (priorRows[0].resolved_at ? `resolved:${priorRows[0].resolution}` : "unresolved")
        : "unknown";

      // 2. Insert into the append-only audit trail
      await tx.query(
        `insert into dlq_remediation_actions 
           (id, execution_id, action, operator_identity, prior_resolution_state, new_resolution_state, created_at)
         values ($1, $2, $3, $4, $5, $6, now())`,
        [
          createId(),
          executionId,
          "resolve",
          operatorIdentity,
          priorState,
          resolution
        ]
      );

      // 3. Perform projection update (backward compatibility!)
      await tx.query(
        `update execution_dead_letters
         set resolved_at = now(), resolution = $2
         where execution_id = $1`,
        [executionId, resolution]
      );
    });
  }

  private toEntry(row: {
    execution_id: string;
    worker_id: string | null;
    attempt: number;
    error: { message: string };
    context: { agentId: string; firstFailedAt: string; taskSnapshot?: Record<string, unknown> };
    moved_at: string;
  }): DeadLetterEntry {
    return {
      // DeadLetterEntry.id is the same as executionId — no separate primary key needed.
      id: row.execution_id,
      executionId: row.execution_id,
      agentId: row.context.agentId,
      workerId: row.worker_id ?? "unknown",
      failureCount: row.attempt,
      lastError: row.error.message,
      firstFailedAt: row.context.firstFailedAt,
      movedAt: row.moved_at,
      taskSnapshot: row.context.taskSnapshot ?? undefined
    };
  }
}
