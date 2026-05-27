/**
 * V3 — Deploy freeze enforcement contract.
 *
 * Why a dedicated module:
 *   The CD system (ArgoCD / Spinnaker / GitHub Actions) needs a single,
 *   typed answer to "may I promote this release?" that does NOT require
 *   it to recompute burn-rates from Prometheus. The /operator/freeze
 *   endpoint is the contract; this module is the in-process logic.
 *
 * Two inputs feed the answer:
 *   1. SloGovernor.shouldFreezeDeploys() — automatic, telemetry-driven.
 *   2. Operator override — manual force-freeze for e.g. a known-bad
 *      provider incident where deploy could mask the regression.
 *
 * One output: a `FreezeDecision`. Boolean fields are intentional rather
 * than free-text so a CD pipeline can `jq -e .frozen == false` reliably.
 *
 * Idempotency:
 *   Decisions include `expiresAt` (set to `null` when telemetry-driven so
 *   the CD pipeline must re-poll). Operator overrides are sticky until
 *   explicitly released or until `expiresAt` elapses.
 */

import type { SloGovernor } from "./sloGovernor.js";

export interface FreezeDecision {
  frozen: boolean;
  reason?: string;
  /** RFC3339 timestamp; null when telemetry-driven (must re-poll). */
  expiresAt: string | null;
  source: "slo" | "operator" | "open";
  /** Snapshot of the SLOs that drove the decision, for transparency. */
  sloEvidence: { name: string; budgetConsumed: number; pageBurnFiring: boolean }[];
}

export class DeployFreezeController {
  private operatorOverride?: { reason: string; expiresAt?: number };

  constructor(private readonly slo: SloGovernor) {}

  decision(nowMs: number = Date.now()): FreezeDecision {
    const sloSnaps = this.slo.snapshotAll(nowMs);
    const sloEvidence = sloSnaps.map((s) => ({
      name: s.name,
      budgetConsumed: isFinite(s.budgetConsumed) ? s.budgetConsumed : 1e9,
      pageBurnFiring: s.burns.some((b) => b.label === "page" && b.firing)
    }));

    if (this.operatorOverride) {
      if (
        this.operatorOverride.expiresAt &&
        this.operatorOverride.expiresAt <= nowMs
      ) {
        this.operatorOverride = undefined;
      } else {
        return {
          frozen: true,
          reason: `operator:${this.operatorOverride.reason}`,
          expiresAt: this.operatorOverride.expiresAt
            ? new Date(this.operatorOverride.expiresAt).toISOString()
            : null,
          source: "operator",
          sloEvidence
        };
      }
    }

    const sloReason = this.slo.freezeReasonIfAny(nowMs);
    if (sloReason) {
      return {
        frozen: true,
        reason: sloReason,
        expiresAt: null,
        source: "slo",
        sloEvidence
      };
    }

    return { frozen: false, expiresAt: null, source: "open", sloEvidence };
  }

  /**
   * Operator-triggered freeze. Optional ttlMs caps the override so a
   * forgotten freeze auto-releases — prevents a "permanent" freeze
   * lingering after the incident is resolved.
   */
  forceFreeze(reason: string, ttlMs?: number): FreezeDecision {
    const expiresAt = ttlMs ? Date.now() + ttlMs : undefined;
    this.operatorOverride = { reason, ...(expiresAt ? { expiresAt } : {}) };
    return this.decision();
  }

  releaseFreeze(): FreezeDecision {
    this.operatorOverride = undefined;
    return this.decision();
  }
}
