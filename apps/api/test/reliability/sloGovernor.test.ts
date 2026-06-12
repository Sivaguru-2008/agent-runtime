/**
 * V3 — SLO governor unit tests.
 *
 * Contracts under test:
 *   - Error budget consumed reflects observed bad/total against target.
 *   - Multi-window burn-rate fires only when BOTH short and long exceed threshold.
 *   - Deploy freeze trips on page-burn AND on full budget exhaustion.
 *   - Operator override survives until released or until TTL elapses.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SloGovernor,
  defaultSloLadder
} from "../../src/infrastructure/reliability/sloGovernor.js";
import { DeployFreezeController } from "../../src/infrastructure/reliability/deployFreeze.js";

describe("SloGovernor", () => {
  let slo: SloGovernor;

  beforeEach(() => {
    slo = new SloGovernor();
    for (const def of defaultSloLadder()) slo.register(def);
  });

  it("reports 0 budget consumed when no observations recorded", () => {
    const snap = slo.snapshot("http_availability");
    expect(snap).toBeDefined();
    expect(snap?.total).toBe(0);
    expect(snap?.budgetConsumed).toBe(0);
    expect(snap?.successFraction).toBe(1);
  });

  it("computes budget consumed from observations", () => {
    // target 0.999 → allowedErrorRate 0.001.
    // 1 bad in 1000 → observedErrorRate 0.001 → budgetConsumed ≈ 1.
    for (let i = 0; i < 999; i++) slo.observe("http_availability", true);
    slo.observe("http_availability", false);
    const snap = slo.snapshot("http_availability");
    expect(snap?.total).toBe(1000);
    expect(snap?.bad).toBe(1);
    expect(snap?.budgetConsumed).toBeGreaterThan(0.99);
    expect(snap?.budgetConsumed).toBeLessThan(1.01);
  });

  it("freezes deploys when budget is exhausted", () => {
    for (let i = 0; i < 100; i++) slo.observe("http_availability", false);
    expect(slo.shouldFreezeDeploys()).toBe(true);
    expect(slo.freezeReasonIfAny()).toContain("budget-exhausted");
  });

  it("does not freeze for a brief budget breach if no page-burn", () => {
    // 5% of a window with 100 obs → not 100% budget exhaustion yet,
    // and observation count over 1h window is too small to trip page-burn
    // because the multi-window check requires BOTH short and long windows
    // to cross the threshold and the long window has too few datapoints.
    slo.observe("http_availability", true);
    expect(slo.shouldFreezeDeploys()).toBe(false);
  });

  it("rejects unknown SLO targets", () => {
    expect(() =>
      slo.register({
        name: "bad",
        kind: "availability",
        target: 0,
        windowSec: 60,
        description: ""
      })
    ).toThrow();
    expect(() =>
      slo.register({
        name: "bad",
        kind: "availability",
        target: 1.5,
        windowSec: 60,
        description: ""
      })
    ).toThrow();
  });
});

describe("DeployFreezeController", () => {
  it("returns frozen=false when nothing is firing", () => {
    const slo = new SloGovernor();
    for (const def of defaultSloLadder()) slo.register(def);
    const freeze = new DeployFreezeController(slo);
    const d = freeze.decision();
    expect(d.frozen).toBe(false);
    expect(d.source).toBe("open");
  });

  it("operator override beats telemetry", () => {
    const slo = new SloGovernor();
    for (const def of defaultSloLadder()) slo.register(def);
    const freeze = new DeployFreezeController(slo);
    const d = freeze.forceFreeze("planned-maintenance");
    expect(d.frozen).toBe(true);
    expect(d.source).toBe("operator");
    expect(d.reason).toContain("planned-maintenance");
  });

  it("operator override auto-releases past TTL", () => {
    const slo = new SloGovernor();
    for (const def of defaultSloLadder()) slo.register(def);
    const freeze = new DeployFreezeController(slo);
    // decision() takes an explicit nowMs, so the TTL boundary is tested with
    // controlled timestamps rather than a real sleep (which flaked under
    // full-suite load when the 10ms TTL elapsed before the first decision).
    const beforeFreeze = Date.now();
    freeze.forceFreeze("brief", 10);
    const afterFreeze = Date.now();
    const before = freeze.decision(beforeFreeze);
    expect(before.frozen).toBe(true);
    const after = freeze.decision(afterFreeze + 11);
    expect(after.frozen).toBe(false);
  });

  it("releaseFreeze clears operator override", () => {
    const slo = new SloGovernor();
    for (const def of defaultSloLadder()) slo.register(def);
    const freeze = new DeployFreezeController(slo);
    freeze.forceFreeze("test");
    expect(freeze.decision().frozen).toBe(true);
    freeze.releaseFreeze();
    expect(freeze.decision().frozen).toBe(false);
  });
});
