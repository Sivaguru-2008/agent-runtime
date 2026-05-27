/**
 * V3 — Split-brain guard.
 *
 * Problem solved:
 *   In a multi-region topology, a network partition can leave two regions
 *   both believing they are primary. Without a fencing barrier, both will
 *   accept writes against their local replicas, producing diverging state
 *   that cannot be reconciled.
 *
 * Mechanism:
 *   Every write-side actor (scheduler, recovery loop, DLQ remediator)
 *   passes its `fencingToken` (read from RegionAwareness at acquisition
 *   time) into `assertCanWrite`. The guard rejects the write if the
 *   current token has advanced — meaning a failover happened underneath
 *   the actor and it must re-acquire its lease / re-enqueue its work
 *   under the new primary. This is identical in spirit to the Chubby /
 *   etcd fencing-token pattern.
 *
 * Why this lives separate from CircuitBreaker:
 *   A circuit breaker rejects requests when a downstream is failing. The
 *   split-brain guard rejects writes when THIS process should no longer
 *   be writing at all. They protect against different failure modes and
 *   must not be conflated — silencing the SBG with a circuit-breaker
 *   reset would re-enable split-brain.
 */

import { getRegionAwareness } from "./regionAwareness.js";

export class StaleFencingTokenError extends Error {
  readonly code = "STALE_FENCING_TOKEN" as const;
  constructor(public readonly heldToken: number, public readonly currentToken: number) {
    super(
      `write rejected: held fencing token ${heldToken} is older than current ${currentToken} — ` +
        `region failover occurred mid-operation`
    );
  }
}

export class NonPrimaryWriteError extends Error {
  readonly code = "NON_PRIMARY_WRITE" as const;
  constructor(public readonly regionId: string, public readonly role: string) {
    super(`write rejected: region ${regionId} is currently in role ${role}, not active`);
  }
}

/**
 * Snapshot the current write-side authority. Call this at the START of a
 * critical section; pass the result to assertCanWrite later to prove the
 * topology has not shifted underneath you.
 */
export function acquireFencingToken(): { token: number; regionId: string } {
  const t = getRegionAwareness().topology();
  if (t.role !== "active") {
    throw new NonPrimaryWriteError(t.regionId, t.role);
  }
  return { token: t.fencingToken, regionId: t.regionId };
}

/**
 * Verify that the topology has not shifted since `acquireFencingToken` was
 * called and that this region is still the active primary. Throws if a
 * failover occurred or this region was demoted. Callers should let the
 * error propagate — retrying after a failover is the caller's job, not
 * the guard's.
 */
export function assertCanWrite(held: { token: number; regionId: string }): void {
  const t = getRegionAwareness().topology();
  if (t.role !== "active") {
    throw new NonPrimaryWriteError(t.regionId, t.role);
  }
  if (t.regionId !== held.regionId) {
    throw new NonPrimaryWriteError(t.regionId, "region-id-mismatch");
  }
  if (t.fencingToken > held.token) {
    throw new StaleFencingTokenError(held.token, t.fencingToken);
  }
}

/**
 * Convenience wrapper. Acquires the fencing token, runs the critical
 * section, asserts the token is still valid, then returns the result.
 *
 * Note: the check is strict — if a failover happened mid-flight the
 * result is discarded and the caller sees a StaleFencingTokenError. The
 * caller decides whether to retry under the new primary.
 */
export async function withFencingGuard<T>(fn: () => Promise<T>): Promise<T> {
  const held = acquireFencingToken();
  const out = await fn();
  assertCanWrite(held);
  return out;
}
