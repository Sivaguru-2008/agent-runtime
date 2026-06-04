import type { ReplaySnapshot } from "../../../domain/replay.js";
import type {
  SnapshotStore,
  SnapshotIntegrityViolationReporter,
  SnapshotListOptions
} from "../../../domain/cognitionPorts.js";
import type { PgClient } from "./pgClient.js";
import {
  SnapshotCorruptionError,
  computeSnapshotIntegrityHash,
  verifySnapshotIntegrity
} from "../../../runtime/replay/snapshotIntegrity.js";

/**
 * Postgres-backed SnapshotStore. `nearest` resolves in O(log n) via the
 * (cognition_id, frame_index desc) index — replay seek does not scan the
 * snapshot list.
 *
 * Phase C — integrity validation (migration 0009):
 *   every put() stamps a recomputed integrityHash into the `integrity_hash`
 *   column; every get()/nearest()/list path recomputes the hash from the
 *   hydrated graph and rejects the row with SnapshotCorruptionError +
 *   SNAPSHOT_INTEGRITY_VIOLATED on mismatch. Legacy rows persisted before
 *   the column landed (integrity_hash IS NULL) are passed through
 *   unverified — they will be stamped on the next put().
 *
 * Task A1 — snapshot immutability (migration 0013):
 *   put() now persists the FULL immutable graph payload inside the new
 *   `graph_full` jsonb column. Reads prefer graph_full and reconstruct the
 *   snapshot WITHOUT touching live cognition_nodes / cognition_handoffs.
 *
 *   Why live hydration is unsafe:
 *     cognition_nodes is mutable in production (recovery rewrites,
 *     branch-from-node, retries). The original design persisted only a
 *     "thin" envelope and rebuilt the full graph at read time by joining
 *     those rows. When the rows had been touched between put() and read,
 *     the hydrated graph no longer matched the graph that was hashed at
 *     put(). That produced false SnapshotCorruptionError throws under
 *     normal operation AND, for trivial mutations that happen to hash the
 *     same, silently fed NEWER state into recovery — replay then resumed
 *     from a starting graph the original execution never observed.
 *
 *   Why replay must be immutable:
 *     A snapshot is the durable checkpoint that recovery hydrates from.
 *     If two reads of the same snapshot id can yield different graphs,
 *     replay is no longer deterministic and the integrity hash is no
 *     longer a meaningful invariant — it is just an alarm that fires
 *     whenever upstream mutates the wrong table.
 *
 *   Why integrity hashes require payload closure:
 *     The hash covers a canonical projection of { graph, eventSequence,
 *     frameIndex }. For the verification to mean "the bytes I am about to
 *     hydrate are the bytes that were captured", the graph the verifier
 *     hashes must be identical to the graph the writer hashed. Persisting
 *     the full graph in graph_full closes that loop — there is no longer
 *     a window where another writer can shift the payload underneath the
 *     verifier.
 *
 *   Legacy fallback:
 *     Rows where graph_full IS NULL fall back to thin hydration so
 *     snapshots persisted before 0013 remain readable. Every such read
 *     fires `legacyHydrationReporter` (when set) so operators can quantify
 *     and decommission legacy surface area. We deliberately do NOT
 *     auto-backfill graph_full — the only source for legacy rows is the
 *     live mutable cognition_nodes table, and backfilling from there
 *     would capture present state rather than the snapshot's historical
 *     state, re-introducing exactly the bug 0013 fixes.
 *
 * Task A2 — list-path integrity (no migration):
 *   listByCognition() now verifies every returned row by default. The
 *   operator timeline view is the sole production caller and must not
 *   silently render corrupt history. Forensic admin endpoints may pass
 *   `{ bypassIntegrityForForensics: true }` to surface raw bytes — the
 *   integrity reporter still fires on mismatch so the bus event is not
 *   suppressed.
 */
export class PostgresSnapshotStore implements SnapshotStore {
  private reporter: SnapshotIntegrityViolationReporter | undefined;
  private legacyHydrationReporter: ((info: LegacyHydrationInfo) => void) | undefined;

  constructor(private readonly client: PgClient) {}

  setIntegrityViolationReporter(reporter: SnapshotIntegrityViolationReporter): void {
    this.reporter = reporter;
  }

  /**
   * Optional forensic visibility hook: invoked once per snapshot row that
   * had to fall back to thin/live hydration because graph_full was NULL.
   * Wired by the runtime container to a counter / log sink so operators
   * can track legacy surface area and confirm decommissioning.
   *
   * Best-effort only — reporter exceptions are swallowed.
   */
  setLegacyHydrationReporter(reporter: (info: LegacyHydrationInfo) => void): void {
    this.legacyHydrationReporter = reporter;
  }

  async put(snapshot: ReplaySnapshot): Promise<void> {
    // The thin envelope is retained on new writes for downgrade safety:
    // an older API binary that rolls back to pre-A1 code reads the thin
    // envelope from `graph` and hydrates from cognition_nodes as before.
    // This is the only reason `graph` is still populated — the read path
    // in this binary prefers graph_full.
    const thinGraph = {
      __thin: true,
      id: snapshot.graph.id,
      executionId: snapshot.graph.executionId,
      agentId: snapshot.graph.agentId,
      parentCognitionId: snapshot.graph.parentCognitionId,
      parentNodeId: snapshot.graph.parentNodeId,
      tenantId: snapshot.graph.tenantId,
      phase: snapshot.graph.phase,
      startedAt: snapshot.graph.startedAt,
      completedAt: snapshot.graph.completedAt,
      output: snapshot.graph.output,
      ownerWorkerId: snapshot.graph.ownerWorkerId,
      uncertainty: snapshot.graph.uncertainty,
      nodeIds: snapshot.graph.nodes.map((n) => n.id)
    };

    // Integrity hash is computed over the FULL graph — the same payload
    // we are about to persist verbatim into graph_full. We round-trip through
    // JSON.parse(JSON.stringify(...)) so the hash covers the exact shape that
    // Postgres jsonb will return on read — without residual `undefined` keys
    // that JSON.stringify strips.  After 0013, the verifier's recompute reads
    // graph_full and gets byte-for-byte the same canonical projection. There
    // is no remaining mutable join on the normal read path.
    const graphForHash = JSON.parse(JSON.stringify(snapshot.graph));
    const integrityHash = computeSnapshotIntegrityHash({
      ...snapshot,
      graph: graphForHash
    });

    await this.client.query(
      `insert into replay_snapshots (
         id, cognition_id, execution_id, frame_index, event_sequence,
         captured_at, graph, graph_full, event_count, integrity_hash
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (id) do update set
         graph = excluded.graph,
         graph_full = excluded.graph_full,
         event_count = excluded.event_count,
         captured_at = excluded.captured_at,
         integrity_hash = excluded.integrity_hash`,
      [
        snapshot.id,
        snapshot.cognitionId,
        snapshot.executionId,
        snapshot.frameIndex,
        snapshot.eventSequence,
        snapshot.capturedAt,
        JSON.stringify(thinGraph),
        JSON.stringify(snapshot.graph),
        snapshot.eventCount,
        integrityHash
      ]
    );
  }

  async get(snapshotId: string): Promise<ReplaySnapshot | undefined> {
    const { rows } = await this.client.query<SnapshotRow>(
      `select id, cognition_id, execution_id, frame_index, event_sequence,
              captured_at, graph, graph_full, event_count, integrity_hash
         from replay_snapshots where id = $1`,
      [snapshotId]
    );
    if (!rows[0]) return undefined;
    const snap = await this.rowToSnapshot(rows[0]);
    this.assertIntegrity(snap, "get");
    return snap;
  }

  async listByCognition(
    cognitionId: string,
    options?: SnapshotListOptions
  ): Promise<ReplaySnapshot[]> {
    const { rows } = await this.client.query<SnapshotRow>(
      `select id, cognition_id, execution_id, frame_index, event_sequence,
              captured_at, graph, graph_full, event_count, integrity_hash
         from replay_snapshots
         where cognition_id = $1
         order by frame_index asc`,
      [cognitionId]
    );
    const snaps: ReplaySnapshot[] = [];
    for (const r of rows) {
      const snap = await this.rowToSnapshot(r);
      // Task A2: never render unverified rows into the operator timeline.
      // The forensic bypass is opt-in and STILL fires the reporter so the
      // SNAPSHOT_INTEGRITY_VIOLATED event reaches the bus regardless.
      if (options?.bypassIntegrityForForensics) {
        this.reportIfCorrupt(snap, "list");
      } else {
        this.assertIntegrity(snap, "list");
      }
      snaps.push(snap);
    }
    return snaps;
  }

  async nearest(cognitionId: string, frameIndex: number): Promise<ReplaySnapshot | undefined> {
    const { rows } = await this.client.query<SnapshotRow>(
      `select id, cognition_id, execution_id, frame_index, event_sequence,
              captured_at, graph, graph_full, event_count, integrity_hash
         from replay_snapshots
         where cognition_id = $1 and frame_index <= $2
         order by frame_index desc
         limit 1`,
      [cognitionId, frameIndex]
    );
    if (!rows[0]) return undefined;
    const snap = await this.rowToSnapshot(rows[0]);
    this.assertIntegrity(snap, "nearest");
    return snap;
  }

  private assertIntegrity(snap: ReplaySnapshot, operation: "get" | "nearest" | "list"): void {
    const result = verifySnapshotIntegrity(snap);
    if (result.ok) return;
    try {
      this.reporter?.({
        snapshotId: snap.id,
        cognitionId: snap.cognitionId,
        executionId: snap.executionId,
        frameIndex: snap.frameIndex,
        storedHash: result.storedHash,
        computedHash: result.computedHash,
        operation
      });
    } catch {
      // Reporter failures must not mask the corruption throw.
    }
    throw new SnapshotCorruptionError(
      snap.id,
      snap.cognitionId,
      snap.executionId,
      snap.frameIndex,
      result.storedHash,
      result.computedHash
    );
  }

  /**
   * Forensic-bypass surface: fire the integrity reporter on mismatch but
   * do not throw. Caller has explicitly asked for raw bytes; we still
   * want the SNAPSHOT_INTEGRITY_VIOLATED bus event so dashboards reflect
   * the corruption.
   */
  private reportIfCorrupt(snap: ReplaySnapshot, operation: "get" | "nearest" | "list"): void {
    const result = verifySnapshotIntegrity(snap);
    if (result.ok) return;
    try {
      this.reporter?.({
        snapshotId: snap.id,
        cognitionId: snap.cognitionId,
        executionId: snap.executionId,
        frameIndex: snap.frameIndex,
        storedHash: result.storedHash,
        computedHash: result.computedHash,
        operation
      });
    } catch {
      // swallow — forensic bypass is best-effort.
    }
  }

  private async rowToSnapshot(row: SnapshotRow): Promise<ReplaySnapshot> {
    let graph = row.graph_full ?? row.graph;
    const isLegacyRow = row.graph_full == null;

    if (isLegacyRow && row.graph && (row.graph as any).__thin) {
      // Legacy fallback ONLY: row was persisted before migration 0013, so
      // graph_full is NULL. We hydrate the thin envelope from cognition_nodes
      // exactly as before. This is the path that can return graphs that
      // disagree with the integrity hash (because cognition_nodes is
      // mutable); the resulting SnapshotCorruptionError is still the
      // correct outcome — replay must not proceed against a graph that
      // may have drifted from the captured state.
      try {
        this.legacyHydrationReporter?.({
          snapshotId: row.id,
          cognitionId: row.cognition_id,
          executionId: row.execution_id,
          frameIndex: row.frame_index
        });
      } catch {
        // Reporter failures are not allowed to mask the read.
      }

      const thin = row.graph as any;
      const nodeIds = thin.nodeIds as string[];
      let nodes: any[] = [];
      if (nodeIds.length > 0) {
        const { rows: nodeRows } = await this.client.query<any>(
          `select id, cognition_id, execution_id, parent_node_id, sequence, role, phase,
                  status, input_fingerprint, input, output, token_stream, uncertainty,
                  memory_influence, started_at, completed_at, duration_ms, worker_id,
                  replayed_from_node_id
             from cognition_nodes
             where id = any($1)
             order by sequence asc`,
          [nodeIds]
        );
        nodes = nodeRows.map((r) => {
          const node: Record<string, unknown> = {
            id: r.id,
            cognitionId: r.cognition_id,
            executionId: r.execution_id,
            sequence: r.sequence,
            role: r.role,
            phase: r.phase,
            status: r.status,
            inputFingerprint: r.input_fingerprint,
            input: r.input,
            startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
          };
          if (r.parent_node_id != null) node.parentNodeId = r.parent_node_id;
          if (r.output != null) node.output = r.output;
          if (r.token_stream != null) node.tokenStream = r.token_stream;
          if (r.uncertainty != null) node.uncertainty = r.uncertainty;
          if (r.memory_influence != null) node.memoryInfluence = r.memory_influence;
          if (r.completed_at != null) node.completedAt = r.completed_at instanceof Date ? r.completed_at.toISOString() : String(r.completed_at);
          if (r.duration_ms != null) node.durationMs = r.duration_ms;
          if (r.worker_id != null) node.workerId = r.worker_id;
          if (r.replayed_from_node_id != null) node.replayedFromNodeId = r.replayed_from_node_id;
          return node;
        });
      }

      const { rows: handoffRows } = await this.client.query<any>(
        `select from_node_id, to_role, reason, carry_over
           from cognition_handoffs
           where cognition_id = $1`,
        [thin.id]
      );

      const visibleNodeIds = new Set(nodeIds);
      const handoffs = handoffRows
        .filter((h) => visibleNodeIds.has(h.from_node_id))
        .map((h) => ({
          fromNodeId: h.from_node_id,
          toRole: h.to_role,
          reason: h.reason,
          carryOver: h.carry_over
        }));

      // Typed as the graph payload (not Record<string, unknown>) so the
      // reconstructed shape is type-checked against CognitionGraph. The
      // required fields are all set in this literal; the optional fields are
      // added conditionally below. The conditional pattern still OMITS absent
      // keys at runtime (TS typing does not emit `undefined` values), so the
      // canonical projection the integrity hash covers is unchanged.
      const reconstructed: ReplaySnapshot["graph"] = {
        id: thin.id,
        executionId: thin.executionId,
        agentId: thin.agentId,
        phase: thin.phase,
        startedAt: thin.startedAt,
        nodes,
        handoffs
      };
      if (thin.parentCognitionId != null) reconstructed.parentCognitionId = thin.parentCognitionId;
      if (thin.parentNodeId != null) reconstructed.parentNodeId = thin.parentNodeId;
      if (thin.tenantId != null) reconstructed.tenantId = thin.tenantId;
      if (thin.completedAt != null) reconstructed.completedAt = thin.completedAt;
      if (thin.output != null) reconstructed.output = thin.output;
      if (thin.ownerWorkerId != null) reconstructed.ownerWorkerId = thin.ownerWorkerId;
      if (thin.uncertainty != null) reconstructed.uncertainty = thin.uncertainty;
      graph = reconstructed;
    }

    return {
      id: row.id,
      cognitionId: row.cognition_id,
      executionId: row.execution_id,
      frameIndex: row.frame_index,
      eventSequence: Number(row.event_sequence),
      capturedAt: row.captured_at instanceof Date ? row.captured_at.toISOString() : String(row.captured_at),
      graph,
      eventCount: row.event_count,
      integrityHash: row.integrity_hash ?? undefined
    };
  }
}

interface SnapshotRow {
  id: string;
  cognition_id: string;
  execution_id: string;
  frame_index: number;
  event_sequence: string | number;
  captured_at: Date | string;
  /**
   * Thin envelope, retained on new writes for downgrade safety to older
   * API binaries. NEVER consulted on this binary when graph_full is set.
   */
  graph: ReplaySnapshot["graph"];
  /**
   * Immutable full graph payload. Present on rows written after migration
   * 0013_replay_snapshot_immutability. NULL for legacy rows — see
   * rowToSnapshot's legacy fallback block.
   */
  graph_full: ReplaySnapshot["graph"] | null;
  event_count: number;
  /** Nullable: legacy snapshots persisted before migration 0009 have no hash. */
  integrity_hash: string | null;
}

export interface LegacyHydrationInfo {
  snapshotId: string;
  cognitionId: string;
  executionId: string;
  frameIndex: number;
}
