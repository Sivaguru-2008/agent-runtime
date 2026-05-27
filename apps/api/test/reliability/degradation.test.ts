/**
 * V3 — Degradation classifier + readiness probe tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DegradationClassifier } from "../../src/infrastructure/reliability/degradationClassifier.js";
import { ReadinessProbe } from "../../src/infrastructure/reliability/readinessProbe.js";
import { __resetRegionAwarenessForTests } from "../../src/infrastructure/reliability/regionAwareness.js";

describe("DegradationClassifier", () => {
  beforeEach(() => {
    __resetRegionAwarenessForTests({ regionId: "us-east-1", primaryRegionId: "us-east-1" });
  });

  it("reports nominal with no subsystem reports", () => {
    const c = new DegradationClassifier();
    const s = c.snapshot();
    expect(s.level).toBe("nominal");
    expect(s.readyForTraffic).toBe(true);
  });

  it("partial when only secondary subsystems degraded", () => {
    const c = new DegradationClassifier();
    c.report({ name: "otel-exporter", status: "down", criticality: "secondary" });
    const s = c.snapshot();
    expect(s.level).toBe("partial");
    expect(s.readyForTraffic).toBe(true);
  });

  it("critical when one core subsystem down", () => {
    const c = new DegradationClassifier();
    c.report({ name: "postgres", status: "down", criticality: "core" });
    const s = c.snapshot();
    expect(s.level).toBe("critical");
    expect(s.readyForTraffic).toBe(false);
  });

  it("failed when two core subsystems down", () => {
    const c = new DegradationClassifier();
    c.report({ name: "postgres", status: "down", criticality: "core" });
    c.report({ name: "redis", status: "down", criticality: "core" });
    expect(c.snapshot().level).toBe("failed");
  });

  it("treats stale reports as down", () => {
    const c = new DegradationClassifier({ staleAfterMs: 10 });
    c.report({ name: "postgres", status: "healthy", criticality: "core", at: Date.now() - 1000 });
    const s = c.snapshot();
    expect(s.level).toBe("critical");
  });

  it("readiness probe maps levels to HTTP status correctly", () => {
    const c = new DegradationClassifier();
    const r = new ReadinessProbe(c);
    expect(r.evaluate().ready).toBe(true);
    c.report({ name: "postgres", status: "down", criticality: "core" });
    expect(r.evaluate().ready).toBe(false);
  });

  it("readiness probe surfaces region role in serveTraffic", () => {
    __resetRegionAwarenessForTests({ regionId: "us-west-2", primaryRegionId: "us-east-1" });
    const c = new DegradationClassifier();
    const r = new ReadinessProbe(c);
    const rep = r.evaluate();
    // Passive region: not ready to serve write traffic.
    expect(rep.serveTraffic).toBe(false);
    expect(rep.reasons).toContain("region:passive");
  });
});
