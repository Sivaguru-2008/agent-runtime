/**
 * Postgres-backed FenceStore — the production substrate for the fence state
 * machine (docs/specs/fence-state-machine.md), backing the execution_fences
 * table from migration 0016.
 *
 * The correctness-critical operation is transition(): a single UPDATE whose
 * WHERE clause is the compare-and-set. Postgres evaluates the row predicate and
 * applies the write atomically under the row's write lock, so the state check
 * AND the ownership check AND the write happen with no interleaving window —
 * the same guarantee the in-memory store gets from the single-threaded event
 * loop. When the UPDATE matches zero rows we issue one follow-up SELECT (on the
 * no-mutation path only) to classify *why* it failed: STALE_STATE vs
 * STALE_OWNER vs MISSING.
 *
 * This mirrors the proven CTE pattern in postgresToolCallDedupStore.ts.
 */

import type { PgClient } from "./pgClient.js";
import {
  type FenceRecord,
  type FenceReserveInput,
  type FenceStore,
  type FenceTransitionOutcome,
  type FenceTransitionRequest
} from "../../../runtime/fence/fenceProtocol.js";
import { assertFenceTransition, type FenceState } from "../../../runtime/fence/fenceState.js";
import { assertCanonicalOwnershipConsistency } from "../../../runtime/canonicalSemantics.js";

interface FenceRow {
  fence_id: string;
  execution_id: string;
  step_seq: number;
  tenant_id: string;
  tool_name: string;
  idempotency_key: string;
  args_hash: string;
  state: FenceState;
  owner_worker_id: string;
  lease_attempt: string | number;
  lease_epoch?: string | number | null;
  fencing_token?: string | number | null;
  ownership_version?: string | number | null;
  worker_identity?: string | null;
  output: Record<string, unknown> | null;
  last_error: string | null;
  resolution: "COMMITTED" | "FAILED" | "ABANDONED" | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PostgresFenceStore implements FenceStore {
  constructor(private readonly db: PgClient) {}

  async reserve(input: FenceReserveInput): Promise<{ created: boolean; record: FenceRecord }> {
    // F7: a divergent canonical context must never establish a fence.
    assertCanonicalOwnershipConsistency(input.owner, { fenceId: input.fenceId, op: "reserve" });
    // Atomic insert-if-absent. ON CONFLICT DO NOTHING means a concurrent
    // reserver collapses onto the single existing row. We then read back the
    // live row (ours or theirs) and report whether we created it.
    const inserted = await this.db.query<FenceRow & { was_inserted: boolean }>(
      `insert into execution_fences
         (fence_id, execution_id, step_seq, tenant_id, tool_name,
          idempotency_key, args_hash, state, owner_worker_id, lease_attempt,
          lease_epoch, fencing_token, ownership_version, worker_identity)
       values ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,$9,$9,$9,$8)
       on conflict (fence_id) do nothing
       returning ${COLS}, true as was_inserted`,
      [
        input.fenceId,
        input.executionId,
        input.stepSeq,
        input.tenantId,
        input.toolName,
        input.idempotencyKey,
        input.argsHash,
        input.owner.workerId,
        input.owner.attempt
      ]
    );
    if (inserted.rows[0]) {
      return { created: true, record: mapRow(inserted.rows[0]) };
    }
    const existing = await this.get(input.fenceId);
    if (!existing) {
      // Lost the insert race AND the row vanished (a reaper deleted it between
      // our INSERT and SELECT). Retry the insert once — extremely rare.
      const retry = await this.db.query<FenceRow>(
        `insert into execution_fences
           (fence_id, execution_id, step_seq, tenant_id, tool_name,
            idempotency_key, args_hash, state, owner_worker_id, lease_attempt,
            lease_epoch, fencing_token, ownership_version, worker_identity)
         values ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,$9,$9,$9,$8)
         on conflict (fence_id) do nothing
         returning ${COLS}`,
        [
          input.fenceId,
          input.executionId,
          input.stepSeq,
          input.tenantId,
          input.toolName,
          input.idempotencyKey,
          input.argsHash,
          input.owner.workerId,
          input.owner.attempt
        ]
      );
      if (retry.rows[0]) return { created: true, record: mapRow(retry.rows[0]) };
      const reread = await this.get(input.fenceId);
      if (reread) return { created: false, record: reread };
      throw new Error(`fence reserve failed to materialize row for ${input.fenceId}`);
    }
    return { created: false, record: existing };
  }

  async transition(req: FenceTransitionRequest): Promise<FenceTransitionOutcome> {
    // F5: reject illegal edges before touching the DB (defense-in-depth; the
    // protocol only ever passes legal edges).
    assertFenceTransition(req.fenceId, req.expectedFrom, req.to);
    // F7: reject a divergent canonical claimant before any compare-and-set.
    assertCanonicalOwnershipConsistency(req.claimant, { fenceId: req.fenceId, op: "transition", to: req.to });

    const sets: string[] = ["state = $2", "updated_at = now()"];
    const params: unknown[] = [req.fenceId, req.to];
    let p = params.length;

    if (req.restampOwner) {
      sets.push(`owner_worker_id = $${++p}`);
      params.push(req.claimant.workerId);
      sets.push(`lease_attempt = $${++p}`);
      params.push(req.claimant.attempt);
      sets.push(`lease_epoch = $${p}`);
      sets.push(`fencing_token = $${p}`);
      sets.push(`ownership_version = $${p}`);
      sets.push(`worker_identity = $${p - 1}`);
    }
    const patch = req.patch;
    if (patch) {
      if ("output" in patch) {
        sets.push(`output = $${++p}::jsonb`);
        params.push(patch.output === undefined ? null : JSON.stringify(patch.output));
      }
      if ("error" in patch) {
        sets.push(`last_error = $${++p}`);
        params.push(patch.error ?? null);
      }
      if ("resolution" in patch) {
        sets.push(`resolution = $${++p}`);
        params.push(patch.resolution ?? null);
      }
      if ("argsHash" in patch && patch.argsHash !== undefined) {
        sets.push(`args_hash = $${++p}`);
        params.push(patch.argsHash);
      }
    }

    // Ownership predicate (F4). A failed predicate matches zero rows ⇒ no write.
    //
    // Fail-CLOSED canonical semantics: EVERY canonical epoch dimension
    // (lease_attempt, fencing_token, lease_epoch, ownership_version) must agree
    // with the claimant for ownership to hold. Using AND — not OR — closes the
    // "ownership resurrection" hole where a stale holder matching a single
    // drifted alias could mutate. `coalesce(..., lease_attempt)` keeps the check
    // NULL-safe for any legacy row predating the canonical-column backfill: an
    // absent alias falls back to lease_attempt (the source of truth) rather than
    // turning the AND into NULL→reject. F7 + the 0020 CHECK constraint guarantee
    // these columns cannot actually diverge at rest, so on valid data this is
    // exactly equivalent to comparing lease_attempt alone.
    const expectedFromIdx = ++p;
    params.push(req.expectedFrom);
    let ownershipPredicate = "true";
    if (req.ownership === "exact") {
      const a = ++p;
      params.push(req.claimant.attempt);
      ownershipPredicate =
        `(lease_attempt = $${a} ` +
        `and coalesce(fencing_token, lease_attempt) = $${a} ` +
        `and coalesce(lease_epoch, lease_attempt) = $${a} ` +
        `and coalesce(ownership_version, lease_attempt) = $${a})`;
    } else if (req.ownership === "monotonic") {
      const a = ++p;
      params.push(req.claimant.attempt);
      ownershipPredicate =
        `($${a} >= lease_attempt ` +
        `and $${a} >= coalesce(fencing_token, lease_attempt) ` +
        `and $${a} >= coalesce(lease_epoch, lease_attempt) ` +
        `and $${a} >= coalesce(ownership_version, lease_attempt))`;
    }

    const { rows } = await this.db.query<FenceRow>(
      `update execution_fences
          set ${sets.join(", ")}
        where fence_id = $1
          and state = $${expectedFromIdx}
          and ${ownershipPredicate}
        returning ${COLS}`,
      params
    );

    if (rows[0]) {
      return { outcome: "APPLIED", record: mapRow(rows[0]) };
    }

    // No mutation happened. Classify why on the read-only path.
    const current = await this.get(req.fenceId);
    if (!current) return { outcome: "MISSING" };
    if (current.state !== req.expectedFrom) {
      return { outcome: "STALE_STATE", record: current };
    }
    // State matched but the ownership predicate did not ⇒ stale owner.
    return { outcome: "STALE_OWNER", record: current };
  }

  async get(fenceId: string): Promise<FenceRecord | undefined> {
    const { rows } = await this.db.query<FenceRow>(
      `select ${COLS} from execution_fences where fence_id = $1`,
      [fenceId]
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async getByStep(executionId: string, stepSeq: number): Promise<FenceRecord | undefined> {
    const { rows } = await this.db.query<FenceRow>(
      `select ${COLS} from execution_fences
        where execution_id = $1 and step_seq = $2
        limit 1`,
      [executionId, stepSeq]
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }
}

const COLS =
  "fence_id, execution_id, step_seq, tenant_id, tool_name, idempotency_key, " +
  "args_hash, state, owner_worker_id, lease_attempt, lease_epoch, fencing_token, ownership_version, worker_identity, output, last_error, " +
  "resolution, created_at, updated_at";

function mapRow(r: FenceRow): FenceRecord {
  const toIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));
  const record: FenceRecord = {
    fenceId: r.fence_id,
    executionId: r.execution_id,
    stepSeq: Number(r.step_seq),
    tenantId: r.tenant_id,
    toolName: r.tool_name,
    idempotencyKey: r.idempotency_key,
    argsHash: r.args_hash,
    state: r.state,
    ownerWorkerId: r.owner_worker_id,
    leaseAttempt: Number(r.lease_attempt),
    leaseEpoch: r.lease_epoch !== undefined && r.lease_epoch !== null ? Number(r.lease_epoch) : Number(r.lease_attempt),
    lease_epoch: r.lease_epoch !== undefined && r.lease_epoch !== null ? Number(r.lease_epoch) : Number(r.lease_attempt),
    fencingToken: r.fencing_token !== undefined && r.fencing_token !== null ? Number(r.fencing_token) : Number(r.lease_attempt),
    fencing_token: r.fencing_token !== undefined && r.fencing_token !== null ? Number(r.fencing_token) : Number(r.lease_attempt),
    ownershipVersion: r.ownership_version !== undefined && r.ownership_version !== null ? Number(r.ownership_version) : Number(r.lease_attempt),
    ownership_version: r.ownership_version !== undefined && r.ownership_version !== null ? Number(r.ownership_version) : Number(r.lease_attempt),
    workerIdentity: r.worker_identity ?? r.owner_worker_id,
    worker_identity: r.worker_identity ?? r.owner_worker_id,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    ...(r.output !== null ? { output: r.output } : {}),
    ...(r.last_error !== null ? { error: r.last_error } : {}),
    ...(r.resolution !== null ? { resolution: r.resolution } : {})
  };
  return record;
}
