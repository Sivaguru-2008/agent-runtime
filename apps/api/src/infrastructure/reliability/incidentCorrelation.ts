/**
 * V3 — Incident correlation metadata.
 *
 * What this enables:
 *   When the on-call engineer pages out at 3am, the first thing they need
 *   is "what other recent events correlate with this alert?". This module
 *   tags every error log line and every SLO-violating execution with a
 *   correlation envelope so an incident reviewer can pull the full set of
 *   correlated signals from a single label.
 *
 * Envelope fields (every one cardinality-controlled):
 *   incidentId     — derived from the active deploy-freeze reason OR the
 *                    burn-rate firing name, OR null when nothing is firing.
 *   regionId       — current process region.
 *   deploymentId   — read from DEPLOYMENT_ID env (CD systems inject this).
 *   releaseHash    — short commit hash, read from RELEASE_HASH env.
 *   correlationKey — short stable hash combining region+incidentId+deploy
 *                    so an alert payload can grep with one string.
 *
 * Cost model:
 *   This module does NOT itself emit logs/metrics — it produces metadata
 *   that the existing pino logger and the metrics registry use. Adding a
 *   ~120-byte envelope per error log is negligible; we do NOT attach it
 *   to info-level logs because those would 10x the per-record overhead.
 */

import { createHash } from "node:crypto";
import { getRegionAwareness } from "./regionAwareness.js";
import type { DeployFreezeController } from "./deployFreeze.js";
import type { SloGovernor } from "./sloGovernor.js";

export interface IncidentEnvelope {
  incidentId: string | null;
  regionId: string;
  deploymentId?: string;
  releaseHash?: string;
  correlationKey: string;
}

export interface IncidentCorrelationOptions {
  deploymentId?: string;
  releaseHash?: string;
}

export class IncidentCorrelator {
  private readonly deploymentId?: string;
  private readonly releaseHash?: string;

  constructor(
    private readonly slo: SloGovernor,
    private readonly freeze: DeployFreezeController | undefined,
    opts?: IncidentCorrelationOptions
  ) {
    this.deploymentId = opts?.deploymentId ?? process.env.DEPLOYMENT_ID;
    this.releaseHash = opts?.releaseHash ?? process.env.RELEASE_HASH;
  }

  current(nowMs: number = Date.now()): IncidentEnvelope {
    const region = getRegionAwareness().topology().regionId;
    const freezeReason = this.freeze?.decision(nowMs).frozen
      ? this.freeze.decision(nowMs).reason
      : undefined;
    const sloReason = this.slo.freezeReasonIfAny(nowMs);
    const incidentId = freezeReason ?? sloReason ?? null;
    const correlationKey = this.deriveCorrelationKey(region, incidentId);
    return {
      incidentId,
      regionId: region,
      ...(this.deploymentId ? { deploymentId: this.deploymentId } : {}),
      ...(this.releaseHash ? { releaseHash: this.releaseHash } : {}),
      correlationKey
    };
  }

  private deriveCorrelationKey(region: string, incidentId: string | null): string {
    const h = createHash("sha256");
    h.update(region);
    h.update("|");
    h.update(incidentId ?? "");
    h.update("|");
    h.update(this.deploymentId ?? "");
    h.update("|");
    h.update(this.releaseHash ?? "");
    return h.digest("hex").slice(0, 12);
  }
}
