import { createHash } from "node:crypto";
import type { ReplaySnapshot } from "../../domain/replay.js";
import { canonicalize } from "../../shared/determinism.js";

/**
 * Phase C — Snapshot integrity.
 *
 * The hash is sha256 over the deterministic canonicalization of:
 *   { graph, eventSequence, frameIndex }
 *
 * Why those three fields and not the whole snapshot:
 *   • graph — what recovery actually hydrates from. Tampering here is the
 *     entire reason this exists.
 *   • eventSequence — the cursor recovery uses to continue forward from.
 *     If a snapshot's cursor is shifted, recovery either replays events the
 *     snapshot already incorporated or skips events it has not seen — both
 *     silently corrupt downstream state.
 *   • frameIndex — the seek anchor. SnapshotStore.nearest uses it to
 *     resolve which snapshot to hand back; a mutated index could pull a
 *     snapshot the caller didn't ask for.
 *
 * Excluded: id, cognitionId, executionId, capturedAt, eventCount.
 *   • id / cognitionId / executionId are foreign-key-like identifiers; the
 *     caller already knows them and uses them to look up the snapshot. They
 *     can't be tampered without breaking the lookup itself.
 *   • capturedAt is wall time, deliberately non-deterministic.
 *   • eventCount is a derived count of events folded into the snapshot;
 *     it's a redundant projection of eventSequence + frameIndex and is not
 *     consumed by recovery.
 *
 * The canonicalize() primitive is shared with the replay fingerprint so the
 * same JSON projection that yields a deterministic per-frame digest is the
 * one we hash here — operators reading both don't have to learn two
 * canonicalization schemes.
 */
export function computeSnapshotIntegrityHash(snapshot: ReplaySnapshot): string {
  const projection = {
    graph: snapshot.graph,
    eventSequence: snapshot.eventSequence,
    frameIndex: snapshot.frameIndex
  };
  return createHash("sha256").update(canonicalize(projection)).digest("hex");
}

/**
 * Stamp an integrity hash on a snapshot. Returns a shallow clone with the
 * hash field set; never mutates the input. Used by SnapshotStore.put() to
 * guarantee every persisted snapshot has a hash, regardless of whether the
 * caller supplied one.
 *
 * Callers MAY supply their own integrityHash (e.g. when round-tripping a
 * snapshot through transport); the helper recomputes anyway because trusting
 * the caller's hash would defeat the validation invariant.
 */
export function stampIntegrityHash(snapshot: ReplaySnapshot): ReplaySnapshot {
  return { ...snapshot, integrityHash: computeSnapshotIntegrityHash(snapshot) };
}

/**
 * Typed error raised by SnapshotStore.get/nearest when a stored snapshot's
 * recomputed integrity hash does not match the persisted value. Modeled on
 * FencingViolationError (executionEngine.ts:54) so callers can branch on
 * `err.name === "SnapshotCorruptionError"` and surface the diagnostic
 * payload without parsing the message.
 *
 * The store also emits SNAPSHOT_INTEGRITY_VIOLATED on the event bus before
 * throwing, so dashboards see corruption events even when the throwing path
 * is not directly observable (e.g. an upstream caller swallows the error).
 */
export class SnapshotCorruptionError extends Error {
  readonly name = "SnapshotCorruptionError";
  constructor(
    public readonly snapshotId: string,
    public readonly cognitionId: string,
    public readonly executionId: string,
    public readonly frameIndex: number,
    public readonly storedHash: string | null,
    public readonly computedHash: string
  ) {
    super(
      `Snapshot integrity violated: snapshot '${snapshotId}' (cognition=${cognitionId} frame=${frameIndex}) recomputed hash ${computedHash} does not match stored hash ${storedHash ?? "<missing>"} — refusing to hydrate corrupt graph`
    );
  }
}

/**
 * Check a snapshot's integrity. Returns null on match (and on legacy
 * snapshots with no persisted hash — see below); returns the
 * SnapshotCorruptionError-ready diagnostic shape on mismatch.
 *
 * Legacy handling: a snapshot with `integrityHash === undefined` cannot be
 * verified (it predates the integrity migration). The store treats those as
 * legacy reads — they are not failed, but they are stamped with a fresh hash
 * the next time they are written. Callers that need to enforce "every read
 * is verified" can set `requireHash: true` to fail-closed on legacy rows.
 */
export interface IntegrityCheckResult {
  ok: boolean;
  storedHash: string | null;
  computedHash: string;
  /** True when the snapshot has no stored hash (predates the migration). */
  legacy: boolean;
}

export function verifySnapshotIntegrity(
  snapshot: ReplaySnapshot,
  options: { requireHash?: boolean } = {}
): IntegrityCheckResult {
  const computedHash = computeSnapshotIntegrityHash(snapshot);
  const storedHash = snapshot.integrityHash ?? null;
  if (storedHash === null) {
    return {
      ok: options.requireHash ? false : true,
      storedHash: null,
      computedHash,
      legacy: true
    };
  }
  return {
    ok: storedHash === computedHash,
    storedHash,
    computedHash,
    legacy: false
  };
}
