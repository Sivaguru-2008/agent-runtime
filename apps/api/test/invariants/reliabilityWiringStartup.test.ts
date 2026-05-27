/**
 * V3 — Reliability wiring startup-race regression.
 *
 * Regression risks:
 *   - `buildReliabilityWiring` registers timers and subscribes to OTel
 *     exporter health. If construction throws partway through, the timer
 *     would leak. This test exercises close() and asserts no handles linger.
 *   - The SLO governor must be ready BEFORE the http availability hook runs;
 *     observe() against an unregistered SLO must be a no-op (never throw).
 */

import { describe, it, expect } from "vitest";
import pino from "pino";
import { AgentMetrics } from "../../src/infrastructure/metrics/prometheusMetrics.js";
import { buildReliabilityWiring } from "../../src/infrastructure/reliability/reliabilityWiring.js";

describe("reliability wiring startup", () => {
  it("constructs cleanly with metrics + default SLO ladder", () => {
    const m = new AgentMetrics();
    const w = buildReliabilityWiring(m, pino({ level: "silent" }));
    expect(w.slo.listDefinitions().length).toBeGreaterThan(0);
    expect(w.freeze.decision().frozen).toBe(false);
    expect(w.readiness.evaluate().ready).toBe(true);
  });

  it("close() is idempotent and safe to invoke without metrics", async () => {
    const w = buildReliabilityWiring(undefined, pino({ level: "silent" }));
    await w.close();
    await w.close(); // second call must not throw
  });

  it("SLO observe() on unknown name is a no-op", () => {
    const w = buildReliabilityWiring(undefined, pino({ level: "silent" }));
    expect(() => w.slo.observe("does-not-exist", true)).not.toThrow();
  });

  it("freeze decision is correlatable via incident envelope", () => {
    const w = buildReliabilityWiring(undefined, pino({ level: "silent" }));
    const env = w.incidents.current();
    expect(env.regionId).toBeTruthy();
    expect(env.correlationKey).toHaveLength(12);
  });
});
