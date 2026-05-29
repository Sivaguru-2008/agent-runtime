/**
 * Postgres-backed ToolCallDedupStore — audit CRITICAL-1.
 *
 * Backs the `tool_call_dedup` table introduced by migration 0010. The hot
 * path is a single UPSERT on the primary key (idempotency_key); see
 * domain/toolDedup.ts for the contract.
 */

import type { PgClient } from "./pgClient.js";
import type {
  BeginCallMode,
  FencedMarkOutcome,
  ToolCallDedupBegin,
  ToolCallDedupRecord,
  ToolCallDedupStore
} from "../../../domain/toolDedup.js";

export interface PostgresToolCallDedupOptions {
  /**
   * How long an IN_FLIGHT row is allowed to remain before a new beginCall
   * treats it as a dead worker's leftover and reclaims the slot. Default
   * 10 minutes — well above the longest reasonable tool wall-clock time.
   */
  staleInFlightMs?: number;
}

export class PostgresToolCallDedupStore implements ToolCallDedupStore {
  private readonly staleInFlightMs: number;

  constructor(
    private readonly db: PgClient,
    opts: PostgresToolCallDedupOptions = {}
  ) {
    this.staleInFlightMs = opts.staleInFlightMs ?? 10 * 60 * 1000;
  }

  async beginCall(input: ToolCallDedupBegin): Promise<BeginCallMode> {
    const { rows } = await this.db.query<{
      status: "IN_FLIGHT" | "RESERVED" | "COMPLETED" | "SUCCEEDED" | "FAILED";
      output: Record<string, unknown> | null;
      created_at: Date | string;
      was_inserted: boolean;
      args_hash: string | null;
    }>(
      `with attempted_insert as (
         insert into tool_call_dedup
           (idempotency_key, execution_id, agent_id, tool_name, attempt, status, tenant_id,
            step_seq, args_hash, fence_token_at_reserve, lease_epoch, fencing_token, ownership_version, worker_identity)
         values ($1, $2, $3, $4, $5, 'RESERVED', $6, $8, $9, $10, $10, $10, $10, 'unknown')
         on conflict (idempotency_key) do update set
           status                  = 'RESERVED',
           execution_id            = excluded.execution_id,
           agent_id                = excluded.agent_id,
           attempt                 = excluded.attempt,
           tenant_id               = excluded.tenant_id,
           created_at              = now(),
           completed_at            = null,
           output                  = null,
           last_error              = null,
           step_seq                = excluded.step_seq,
           args_hash               = excluded.args_hash,
           fence_token_at_reserve  = excluded.fence_token_at_reserve,
           lease_epoch             = excluded.lease_epoch,
           fencing_token           = excluded.fencing_token,
           ownership_version       = excluded.ownership_version,
           worker_identity         = excluded.worker_identity
         where tool_call_dedup.status in ('IN_FLIGHT','RESERVED')
           and tool_call_dedup.created_at < (now() - ($7 || ' milliseconds')::interval)
         returning status, output, created_at, args_hash, true as was_inserted
       )
       select status, output, created_at, args_hash, was_inserted from attempted_insert
       union all
       select status, output, created_at, args_hash, false as was_inserted
         from tool_call_dedup
        where idempotency_key = $1
          and not exists (select 1 from attempted_insert)
       limit 1`,
      [
        input.idempotencyKey,
        input.executionId,
        input.agentId,
        input.toolName,
        input.attempt,
        input.tenantId,
        this.staleInFlightMs,
        input.stepSeq ?? null,
        input.argsHash ?? null,
        input.fenceTokenAtReserve ?? null
      ]
    );

    const row = rows[0];
    if (!row) {
      return { mode: "FIRST_CALL" };
    }

    if (row.was_inserted) {
      return { mode: "FIRST_CALL" };
    }
    if (input.argsHash && row.args_hash && row.args_hash !== input.argsHash) {
      return {
        mode: "ARG_DRIFT",
        recordedArgsHash: row.args_hash,
        observedArgsHash: input.argsHash
      };
    }
    if ((row.status === "COMPLETED" || row.status === "SUCCEEDED") && row.output) {
      return { mode: "RETURN_CACHED", output: row.output };
    }
    if (row.status === "FAILED") {
      await this.db.query(
        `update tool_call_dedup
            set status     = 'RESERVED',
                created_at = now(),
                completed_at = null,
                output     = null,
                last_error = null,
                attempt    = $2,
                step_seq               = coalesce($3, step_seq),
                args_hash              = coalesce($4, args_hash),
                fence_token_at_reserve = coalesce($5, fence_token_at_reserve),
                lease_epoch             = coalesce($5, lease_epoch),
                fencing_token           = coalesce($5, fencing_token),
                ownership_version       = coalesce($5, ownership_version)
          where idempotency_key = $1`,
        [
          input.idempotencyKey,
          input.attempt,
          input.stepSeq ?? null,
          input.argsHash ?? null,
          input.fenceTokenAtReserve ?? null
        ]
      );
      return { mode: "FIRST_CALL" };
    }
    const sinceMs = Date.now() - new Date(row.created_at).getTime();
    return { mode: "POLL_FOR_RESULT", sinceMs };
  }

  async markCompleted(idempotencyKey: string, output: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `update tool_call_dedup
          set status       = 'SUCCEEDED',
              output       = $2::jsonb,
              completed_at = now(),
              last_error   = null
        where idempotency_key = $1
          and status in ('IN_FLIGHT','RESERVED')`,
      [idempotencyKey, JSON.stringify(output)]
    );
  }

  async markFailed(idempotencyKey: string, errorMessage: string): Promise<void> {
    await this.db.query(
      `update tool_call_dedup
          set status       = 'FAILED',
              last_error   = $2,
              completed_at = now()
        where idempotency_key = $1
          and status in ('IN_FLIGHT','RESERVED')`,
      [idempotencyKey, errorMessage]
    );
  }

  async markCompletedFenced(input: {
    idempotencyKey: string;
    executionId: string;
    expectedFencingToken: number;
    output: Record<string, unknown>;
  }): Promise<FencedMarkOutcome> {
    const { rows } = await this.db.query<{ idempotency_key: string }>(
      `with lease_ok as (
         select 1
           from execution_leases
          where execution_id = $2
            and (attempt      = $3
                 and coalesce(fencing_token, attempt)     = $3
                 and coalesce(lease_epoch, attempt)       = $3
                 and coalesce(ownership_version, attempt) = $3)
            and status in ('LEASED', 'RENEWING', 'RECOVERY_OWNED')
            and expires_at   > now()
          for share
       )
       update tool_call_dedup
          set status       = 'SUCCEEDED',
              output       = $4::jsonb,
              completed_at = now(),
              last_error   = null
        where idempotency_key = $1
          and status in ('IN_FLIGHT','RESERVED')
          and exists (select 1 from lease_ok)
        returning idempotency_key`,
      [
        input.idempotencyKey,
        input.executionId,
        input.expectedFencingToken,
        JSON.stringify(input.output)
      ]
    );
    return rows.length === 0 ? { outcome: "FENCED" } : { outcome: "COMMITTED" };
  }

  async markFailedFenced(input: {
    idempotencyKey: string;
    executionId: string;
    expectedFencingToken: number;
    errorMessage: string;
  }): Promise<FencedMarkOutcome> {
    const { rows } = await this.db.query<{ idempotency_key: string }>(
      `with lease_ok as (
         select 1
           from execution_leases
          where execution_id = $2
            and (attempt      = $3
                 and coalesce(fencing_token, attempt)     = $3
                 and coalesce(lease_epoch, attempt)       = $3
                 and coalesce(ownership_version, attempt) = $3)
            and status in ('LEASED', 'RENEWING', 'RECOVERY_OWNED')
            and expires_at   > now()
          for share
       )
       update tool_call_dedup
          set status       = 'FAILED',
              last_error   = $4,
              completed_at = now()
        where idempotency_key = $1
          and status in ('IN_FLIGHT','RESERVED')
          and exists (select 1 from lease_ok)
        returning idempotency_key`,
      [
        input.idempotencyKey,
        input.executionId,
        input.expectedFencingToken,
        input.errorMessage
      ]
    );
    return rows.length === 0 ? { outcome: "FENCED" } : { outcome: "COMMITTED" };
  }

  async get(idempotencyKey: string): Promise<ToolCallDedupRecord | undefined> {
    const { rows } = await this.db.query<{
      idempotency_key: string;
      execution_id: string;
      agent_id: string;
      tool_name: string;
      attempt: number;
      status: ToolCallDedupRecord["status"];
      output: Record<string, unknown> | null;
      last_error: string | null;
      created_at: Date | string;
      completed_at: Date | string | null;
      tenant_id: string;
      step_seq: number | null;
      args_hash: string | null;
      fence_token_at_reserve: number | null;
    }>(
      `select idempotency_key, execution_id, agent_id, tool_name, attempt, status,
              output, last_error, created_at, completed_at, tenant_id,
              step_seq, args_hash, fence_token_at_reserve
         from tool_call_dedup where idempotency_key = $1`,
      [idempotencyKey]
    );
    return mapRow(rows[0]);
  }

  async getByStep(executionId: string, stepSeq: number): Promise<ToolCallDedupRecord | undefined> {
    const { rows } = await this.db.query<{
      idempotency_key: string;
      execution_id: string;
      agent_id: string;
      tool_name: string;
      attempt: number;
      status: ToolCallDedupRecord["status"];
      output: Record<string, unknown> | null;
      last_error: string | null;
      created_at: Date | string;
      completed_at: Date | string | null;
      tenant_id: string;
      step_seq: number | null;
      args_hash: string | null;
      fence_token_at_reserve: number | null;
    }>(
      `select idempotency_key, execution_id, agent_id, tool_name, attempt, status,
              output, last_error, created_at, completed_at, tenant_id,
              step_seq, args_hash, fence_token_at_reserve
         from tool_call_dedup
        where execution_id = $1 and step_seq = $2
        limit 1`,
      [executionId, stepSeq]
    );
    return mapRow(rows[0]);
  }
}

function mapRow(r: {
  idempotency_key: string;
  execution_id: string;
  agent_id: string;
  tool_name: string;
  attempt: number;
  status: ToolCallDedupRecord["status"];
  output: Record<string, unknown> | null;
  last_error: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  tenant_id: string;
  step_seq: number | null;
  args_hash: string | null;
  fence_token_at_reserve: number | null;
} | undefined): ToolCallDedupRecord | undefined {
  if (!r) return undefined;
  return {
    idempotencyKey: r.idempotency_key,
    executionId: r.execution_id,
    agentId: r.agent_id,
    toolName: r.tool_name,
    attempt: Number(r.attempt),
    status: r.status,
    output: r.output ?? undefined,
    lastError: r.last_error ?? undefined,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    completedAt: r.completed_at
      ? (r.completed_at instanceof Date ? r.completed_at.toISOString() : String(r.completed_at))
      : undefined,
    tenantId: r.tenant_id,
    stepSeq: r.step_seq ?? undefined,
    argsHash: r.args_hash ?? undefined,
    fenceTokenAtReserve: r.fence_token_at_reserve ?? undefined
  };
}
