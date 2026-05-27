/**
 * Phase B (carry-over) — Postgres-backed ReplayCertificationStore.
 *
 * Contract under test (mirrors InMemoryReplayCertificationStore):
 *
 *   • put() appends; never overwrites a prior row for the same execution.
 *   • latest() returns the most recent put() for an execution; undefined
 *     when none.
 *   • listForExecution() returns oldest-first chronological order so an
 *     operator can scan the audit trail.
 *   • Multiple executions are isolated — a put() for execution A does not
 *     surface under execution B.
 *   • Round-trip fidelity: frameDigests/chainHash/eventCount/lastEventSequence
 *     all survive jsonb encoding intact.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { tryStartHarness } from "./harness.js";
import { PostgresReplayCertificationStore } from "../../../src/infrastructure/persistence/postgres/postgresReplayCertificationStore.js";
import type { ReplayCertification } from "../../../src/domain/replay.js";

const harness = await tryStartHarness();

afterEach(async () => {
  if (harness) await harness.reset();
});

afterAll(async () => {
  if (harness) await harness.stop();
});

function makeCert(opts: {
  executionId: string;
  workflowVersion?: string;
  capturedAt?: string;
  digests?: string[];
  eventCount?: number;
  lastEventSequence?: number;
  chainHash?: string;
}): ReplayCertification {
  const digests = opts.digests ?? ["d0", "d1", "d2"];
  return {
    executionId: opts.executionId,
    workflowVersion: opts.workflowVersion ?? "agent-v1",
    eventCount: opts.eventCount ?? digests.length,
    lastEventSequence: opts.lastEventSequence ?? digests.length,
    frameDigests: digests,
    chainHash: opts.chainHash ?? "h-baseline",
    capturedAt: opts.capturedAt ?? "2026-05-27T00:00:00.000Z"
  };
}

describe.skipIf(!harness)("PostgresReplayCertificationStore", () => {
  it("put → latest round-trips a single certification with full fidelity", async () => {
    const store = new PostgresReplayCertificationStore(harness!.pg);
    const exec = "exec-cert-rt-1";
    const cert = makeCert({
      executionId: exec,
      digests: ["alpha", "beta", "gamma", "delta"],
      eventCount: 4,
      lastEventSequence: 42,
      chainHash: "chain-1",
      workflowVersion: "agent-v2.0.0"
    });

    await store.put(cert);
    const latest = await store.latest(exec);

    expect(latest).toBeDefined();
    expect(latest!.executionId).toBe(exec);
    expect(latest!.workflowVersion).toBe("agent-v2.0.0");
    expect(latest!.eventCount).toBe(4);
    expect(latest!.lastEventSequence).toBe(42);
    expect(latest!.chainHash).toBe("chain-1");
    expect(latest!.frameDigests).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(latest!.capturedAt).toBe(cert.capturedAt);
  });

  it("latest returns undefined for an unknown execution", async () => {
    const store = new PostgresReplayCertificationStore(harness!.pg);
    expect(await store.latest("exec-never-certified")).toBeUndefined();
    expect(await store.listForExecution("exec-never-certified")).toEqual([]);
  });

  it("put is append-only — successive puts produce N rows ordered oldest-first", async () => {
    const store = new PostgresReplayCertificationStore(harness!.pg);
    const exec = "exec-cert-append";
    const t0 = new Date("2026-05-27T00:00:00.000Z").getTime();
    const captures = [
      makeCert({
        executionId: exec,
        capturedAt: new Date(t0).toISOString(),
        chainHash: "h-0",
        digests: ["a"]
      }),
      makeCert({
        executionId: exec,
        capturedAt: new Date(t0 + 1_000).toISOString(),
        chainHash: "h-1",
        digests: ["a", "b"]
      }),
      makeCert({
        executionId: exec,
        capturedAt: new Date(t0 + 2_000).toISOString(),
        chainHash: "h-2",
        digests: ["a", "b", "c"]
      })
    ];
    for (const c of captures) await store.put(c);

    const list = await store.listForExecution(exec);
    expect(list).toHaveLength(3);
    expect(list.map((c) => c.chainHash)).toEqual(["h-0", "h-1", "h-2"]);
    // Oldest-first ordering.
    expect(list[0].capturedAt < list[1].capturedAt).toBe(true);
    expect(list[1].capturedAt < list[2].capturedAt).toBe(true);

    const latest = await store.latest(exec);
    expect(latest?.chainHash).toBe("h-2");
    expect(latest?.frameDigests).toEqual(["a", "b", "c"]);
  });

  it("isolates executions — a put on exec-A does not surface under exec-B", async () => {
    const store = new PostgresReplayCertificationStore(harness!.pg);
    await store.put(makeCert({ executionId: "exec-A", chainHash: "from-A" }));
    await store.put(makeCert({ executionId: "exec-B", chainHash: "from-B" }));

    const latestA = await store.latest("exec-A");
    const latestB = await store.latest("exec-B");
    expect(latestA?.chainHash).toBe("from-A");
    expect(latestB?.chainHash).toBe("from-B");

    expect(await store.listForExecution("exec-A")).toHaveLength(1);
    expect(await store.listForExecution("exec-B")).toHaveLength(1);
  });

  it("two captures in the same millisecond are tie-broken by id so latest is deterministic", async () => {
    const store = new PostgresReplayCertificationStore(harness!.pg);
    const exec = "exec-cert-tiebreak";
    const at = "2026-05-27T12:00:00.000Z";
    await store.put(makeCert({ executionId: exec, capturedAt: at, chainHash: "first" }));
    await store.put(makeCert({ executionId: exec, capturedAt: at, chainHash: "second" }));

    const latest = await store.latest(exec);
    // The second insert wins (higher bigserial id under identical timestamps).
    expect(latest?.chainHash).toBe("second");

    const list = await store.listForExecution(exec);
    expect(list).toHaveLength(2);
    // Oldest-first by id under identical timestamps.
    expect(list.map((c) => c.chainHash)).toEqual(["first", "second"]);
  });
});
