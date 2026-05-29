import { describe, expect, it } from "vitest";
import {
  COORDINATION_AUTHORITY_MATRIX,
  assertCoordinationAuthorityWiring,
  assertEphemeralLossSafe,
  assertOwnershipResolvesToDurable,
  assertReconstructionDurable,
  classifyAdapter,
  classifyConcern,
  describeAuthorityMatrix,
  ownershipFromCanonical,
  reconcileOwnershipView,
  type CoordinationConcern
} from "../src/runtime/coordinationAuthority.js";
import { InvariantViolation } from "../src/runtime/canonicalSemantics.js";

const ALL_CONCERNS = Object.keys(COORDINATION_AUTHORITY_MATRIX) as CoordinationConcern[];

describe("coordination authority matrix — structural integrity (CA6)", () => {
  it("classifies every concern in the matrix", () => {
    for (const concern of ALL_CONCERNS) {
      expect(() => classifyConcern(concern)).not.toThrow();
      expect(classifyConcern(concern).concern).toBe(concern);
    }
  });

  it("throws CA6 for an unclassified concern", () => {
    expect(() => classifyConcern("NOT_A_CONCERN" as CoordinationConcern)).toThrow(
      /\[invariant:CA6\]/
    );
  });

  it("every DURABLE_TRUTH concern must never depend on Redis", () => {
    for (const c of Object.values(COORDINATION_AUTHORITY_MATRIX)) {
      if (c.durability === "DURABLE_TRUTH") {
        expect(c.mustNeverDependOnRedis).toBe(true);
        expect(c.authority).not.toBe("REDIS");
      }
    }
  });

  it("every REDIS-authority concern is ephemeral and loss-tolerant", () => {
    for (const c of Object.values(COORDINATION_AUTHORITY_MATRIX)) {
      if (c.authority === "REDIS") {
        expect(c.durability).toBe("EPHEMERAL");
        expect(c.mustNeverDependOnRedis).toBe(false);
      }
    }
  });

  it("describeAuthorityMatrix orders durable-first and is exhaustive", () => {
    const ordered = describeAuthorityMatrix();
    expect(ordered.length).toBe(ALL_CONCERNS.length);
    const firstEphemeralIdx = ordered.findIndex((c) => c.durability === "EPHEMERAL");
    const lastDurableIdx = ordered.map((c) => c.durability).lastIndexOf("DURABLE_TRUTH");
    expect(lastDurableIdx).toBeLessThan(firstEphemeralIdx);
  });
});

describe("adapter classification", () => {
  it("maps constructor-name conventions to authorities", () => {
    expect(classifyAdapter("PostgresLeaseStore")).toBe("POSTGRES");
    expect(classifyAdapter("RedisExecutionJobQueue")).toBe("REDIS");
    expect(classifyAdapter("RedisStreamsEventBus")).toBe("REDIS");
    expect(classifyAdapter("InMemoryLeaseStore")).toBe("PROCESS");
    expect(classifyAdapter("NoopToolCallDedupStore")).toBe("PROCESS");
    expect(classifyAdapter("SomeTestDouble")).toBe("UNKNOWN");
  });
});

describe("startup wiring guard (CA1)", () => {
  it("accepts a correct Postgres-durable / Redis-ephemeral split", () => {
    expect(() =>
      assertCoordinationAuthorityWiring([
        { concern: "EXECUTION_LEASE", adapterCtorName: "PostgresLeaseStore" },
        { concern: "FENCE_STATE", adapterCtorName: "PostgresFenceStore" },
        { concern: "EVENT_LOG", adapterCtorName: "PostgresEventStore" },
        { concern: "JOB_QUEUE", adapterCtorName: "RedisExecutionJobQueue" },
        { concern: "EVENT_BUS", adapterCtorName: "RedisStreamsEventBus" }
      ])
    ).not.toThrow();
  });

  it("accepts the in-memory dev/test split for durable concerns", () => {
    const report = assertCoordinationAuthorityWiring([
      { concern: "EXECUTION_LEASE", adapterCtorName: "InMemoryLeaseStore" },
      { concern: "TOOL_CALL_DEDUP", adapterCtorName: "NoopToolCallDedupStore" },
      { concern: "JOB_QUEUE", adapterCtorName: "InMemoryExecutionJobQueue" }
    ]);
    expect(report.every((b) => b.ok)).toBe(true);
  });

  it("FAILS CLOSED (CA1) when a durable concern is backed by Redis", () => {
    expect(() =>
      assertCoordinationAuthorityWiring([
        { concern: "EXECUTION_LEASE", adapterCtorName: "RedisLeaseStore" }
      ])
    ).toThrow(/\[invariant:CA1\]/);

    expect(() =>
      assertCoordinationAuthorityWiring([
        { concern: "FENCE_STATE", adapterCtorName: "RedisFenceStore" }
      ])
    ).toThrow(/correctness state must live in Postgres/);
  });

  it("does NOT throw for an UNKNOWN (test-double) adapter on a durable concern", () => {
    // A test double does not start with 'Redis', so CA1 cannot fire; the guard
    // must tolerate it rather than break unit tests that inject fakes.
    expect(() =>
      assertCoordinationAuthorityWiring([
        { concern: "EXECUTION_STATE", adapterCtorName: "FakeExecutionRepository" }
      ])
    ).not.toThrow();
    const [binding] = assertCoordinationAuthorityWiring([
      { concern: "EXECUTION_STATE", adapterCtorName: "FakeExecutionRepository" }
    ]);
    expect(binding.adapterAuthority).toBe("UNKNOWN");
    expect(binding.ok).toBe(false);
  });

  it("allows Redis on an ephemeral concern (job queue / event bus)", () => {
    expect(() =>
      assertCoordinationAuthorityWiring([
        { concern: "JOB_QUEUE", adapterCtorName: "RedisExecutionJobQueue" },
        { concern: "RATE_LIMIT", adapterCtorName: "RedisRateLimiter" }
      ])
    ).not.toThrow();
  });
});

describe("ephemeral loss safety (CA2)", () => {
  it("every concern in the matrix is loss-safe by construction", () => {
    for (const concern of ALL_CONCERNS) {
      expect(() => assertEphemeralLossSafe(concern)).not.toThrow();
    }
  });
});

describe("reconstruction durability (CA4)", () => {
  it("accepts a recovery plan that reads only durable sources", () => {
    expect(() =>
      assertReconstructionDurable([
        "EVENT_LOG",
        "EXECUTION_CHECKPOINT",
        "EXECUTION_LEASE",
        "REPLAY_METADATA"
      ])
    ).not.toThrow();
  });

  it("accepts reconstructable ephemeral-adjacent concerns (job queue re-enqueue)", () => {
    // JOB_QUEUE is EPHEMERAL but reconstructable from durable execution state.
    expect(() => assertReconstructionDurable(["JOB_QUEUE", "EVENT_BUS"])).not.toThrow();
  });

  it("throws CA4 if reconstruction depends on a non-reconstructable ephemeral concern", () => {
    expect(() => assertReconstructionDurable(["RATE_LIMIT"])).toThrow(/\[invariant:CA4\]/);
    expect(() => assertReconstructionDurable(["EVENT_LOG", "SSE_DEDUPE"])).toThrow(
      /recovery must not require Redis-resident state/
    );
  });
});

describe("ownership reconciliation (CA3 / CA5)", () => {
  const durable = { workerId: "worker-A", attempt: 5, active: true };

  it("agrees when the ephemeral hint matches the durable owner", () => {
    const r = reconcileOwnershipView(durable, { workerId: "worker-A", attempt: 5, source: "job" });
    expect(r.desynchronized).toBe(false);
    expect(r.severity).toBe("NONE");
    expect(r.authoritative).toBe(durable);
  });

  it("classifies a trailing hint as STALE (expected redelivery)", () => {
    const r = reconcileOwnershipView(durable, { workerId: "worker-A", attempt: 3, source: "redis-redeliver" });
    expect(r.severity).toBe("STALE");
    expect(r.authoritative).toBe(durable);
  });

  it("classifies a different owner at the same epoch as CONFLICT", () => {
    const r = reconcileOwnershipView(durable, { workerId: "worker-B", attempt: 5, source: "stale-snapshot" });
    expect(r.severity).toBe("CONFLICT");
    expect(r.authoritative).toBe(durable);
  });

  it("classifies an ephemeral epoch ABOVE durable as IMPOSSIBLE (Redis ahead of Postgres)", () => {
    const r = reconcileOwnershipView(durable, { attempt: 6, source: "phantom" });
    expect(r.severity).toBe("IMPOSSIBLE");
    expect(r.desynchronized).toBe(true);
    // CA5: Postgres still wins — the ephemeral view is never promoted.
    expect(r.authoritative).toBe(durable);
  });

  it("flags an ephemeral claim against no active durable owner as CONFLICT", () => {
    const r = reconcileOwnershipView(undefined, { workerId: "ghost", attempt: 1, source: "orphan-job" });
    expect(r.severity).toBe("CONFLICT");
    expect(r.desynchronized).toBe(true);
  });

  it("is clean when there is no durable owner and no ephemeral claim", () => {
    const r = reconcileOwnershipView(undefined, { source: "empty" });
    expect(r.severity).toBe("NONE");
    expect(r.desynchronized).toBe(false);
  });

  it("treats an inactive durable lease like no owner", () => {
    const r = reconcileOwnershipView(
      { workerId: "worker-A", attempt: 5, active: false },
      { workerId: "worker-A", attempt: 5, source: "job" }
    );
    expect(r.severity).toBe("CONFLICT");
  });

  describe("assertOwnershipResolvesToDurable", () => {
    it("throws CA5 only on IMPOSSIBLE desync", () => {
      expect(() =>
        assertOwnershipResolvesToDurable(durable, { attempt: 99, source: "phantom" })
      ).toThrow(/\[invariant:CA5\]/);
    });

    it("does NOT throw on STALE/CONFLICT/NONE — caller proceeds on the durable view", () => {
      expect(() =>
        assertOwnershipResolvesToDurable(durable, { workerId: "worker-A", attempt: 3, source: "redeliver" })
      ).not.toThrow();
      expect(() =>
        assertOwnershipResolvesToDurable(durable, { workerId: "worker-B", attempt: 5, source: "snapshot" })
      ).not.toThrow();
      const r = assertOwnershipResolvesToDurable(durable, { workerId: "worker-A", attempt: 5, source: "job" });
      expect(r.authoritative).toBe(durable);
    });

    it("the thrown error is an InvariantViolation tagged CA5", () => {
      try {
        assertOwnershipResolvesToDurable(durable, { attempt: 100, source: "x" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(InvariantViolation);
        expect((err as InvariantViolation).invariant).toBe("CA5");
      }
    });
  });

  it("ownershipFromCanonical projects a lease into a DurableOwnership", () => {
    const o = ownershipFromCanonical(
      { workerId: "w", attempt: 7, leaseEpoch: 7, fencingToken: 7, ownershipVersion: 7 },
      true
    );
    expect(o).toEqual({ workerId: "w", attempt: 7, active: true });
  });
});
