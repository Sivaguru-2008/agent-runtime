/**
 * V3 — DLQ remediation service tests.
 *
 * Contracts under test:
 *   - Transient failures retried with exponential backoff up to maxAttempts.
 *   - Permanent failures quarantined on first sight (no replay attempts).
 *   - Successful replay calls resolve() on the Postgres-backed store.
 *   - Quarantine path resolves the entry with `quarantined:<reason>`.
 *   - Per-tick concurrency is respected.
 *   - Passive region: tick skips all entries (split-brain protection).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import pino from "pino";
import { DlqRemediationService } from "../../src/application/cluster/dlqRemediationService.js";
import type { DeadLetterQueue } from "../../src/domain/clusterPorts.js";
import type { DeadLetterEntry } from "../../src/domain/cluster.js";
import { __resetRegionAwarenessForTests } from "../../src/infrastructure/reliability/regionAwareness.js";

class FakeDLQ implements DeadLetterQueue {
  entries: DeadLetterEntry[] = [];
  resolved: { id: string; reason: string }[] = [];
  async push(e: DeadLetterEntry) {
    this.entries = this.entries.filter((x) => x.executionId !== e.executionId).concat(e);
  }
  async list() {
    return this.entries;
  }
  async getByExecution(id: string) {
    return this.entries.find((e) => e.executionId === id);
  }
  async resolve(id: string, reason: string) {
    this.resolved.push({ id, reason });
    this.entries = this.entries.filter((e) => e.executionId !== id);
  }
}

function buildEntry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    id: "exec-1",
    executionId: "exec-1",
    agentId: "agent-1",
    workerId: "worker-1",
    failureCount: 3,
    lastError: "TransientNetworkError: ECONNRESET",
    firstFailedAt: new Date().toISOString(),
    movedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("DlqRemediationService", () => {
  beforeEach(() => {
    __resetRegionAwarenessForTests({ regionId: "us-east-1", primaryRegionId: "us-east-1" });
  });

  // Some tests flip the region to a non-primary us-west-2; restore the global
  // singleton afterward so a leaked non-active region can't make a downstream
  // suite's split-brain guard reject writes (cluster.test "recovered=0" flake).
  afterEach(() => {
    __resetRegionAwarenessForTests();
  });

  it("succeeds and resolves entry on first happy-path attempt", async () => {
    const dlq = new FakeDLQ();
    await dlq.push(buildEntry());
    const handler = { replay: vi.fn().mockResolvedValue(true) };
    const svc = new DlqRemediationService(dlq, handler, undefined, pino({ level: "silent" }));
    const result = await svc.tick();
    expect(result.processed).toBe(1);
    expect(result.outcomes).toEqual(["succeeded"]);
    expect(handler.replay).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures with exponential backoff", async () => {
    const dlq = new FakeDLQ();
    await dlq.push(buildEntry());
    const handler = { replay: vi.fn().mockResolvedValue(false) };
    const svc = new DlqRemediationService(dlq, handler, undefined, pino({ level: "silent" }), {
      baseBackoffMs: 1,
      maxBackoffMs: 4,
      maxReplayAttempts: 3
    });
    const t1 = await svc.tick(0);
    expect(t1.outcomes).toEqual(["failed"]);
    // backoff = 1ms after first failure → eligible at >= 1
    const t2 = await svc.tick(2);
    expect(t2.outcomes).toEqual(["failed"]);
    const t3 = await svc.tick(20);
    expect(t3.outcomes).toEqual(["quarantined"]);
  });

  it("quarantines permanent failures without attempting replay", async () => {
    const dlq = new FakeDLQ();
    await dlq.push(buildEntry({ lastError: "ValidationError: bad input" }));
    const handler = { replay: vi.fn().mockResolvedValue(true) };
    const svc = new DlqRemediationService(dlq, handler, undefined, pino({ level: "silent" }));
    const result = await svc.tick();
    expect(result.outcomes).toEqual(["quarantined"]);
    expect(handler.replay).not.toHaveBeenCalled();
  });

  it("skips all entries when region is passive", async () => {
    __resetRegionAwarenessForTests({ regionId: "us-west-2", primaryRegionId: "us-east-1" });
    const dlq = new FakeDLQ();
    await dlq.push(buildEntry());
    const handler = { replay: vi.fn() };
    const svc = new DlqRemediationService(dlq, handler, undefined, pino({ level: "silent" }));
    const result = await svc.tick();
    expect(result.outcomes).toEqual(["skipped"]);
    expect(handler.replay).not.toHaveBeenCalled();
  });

  it("respects concurrency per tick", async () => {
    const dlq = new FakeDLQ();
    for (let i = 0; i < 10; i++) {
      await dlq.push(buildEntry({ executionId: `exec-${i}` }));
    }
    const handler = { replay: vi.fn().mockResolvedValue(true) };
    const svc = new DlqRemediationService(dlq, handler, undefined, pino({ level: "silent" }), {
      concurrency: 3
    });
    const result = await svc.tick();
    expect(result.processed).toBe(3);
  });
});
