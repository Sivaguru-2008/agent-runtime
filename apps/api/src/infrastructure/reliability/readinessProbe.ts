/**
 * V3 — Readiness probe orchestrator.
 *
 * Distinct from the existing `/health` (liveness):
 *   - Liveness answers "should the orchestrator restart this pod?"
 *   - Readiness answers "should the load balancer send this pod traffic?"
 *
 * Readiness composes:
 *   - DegradationClassifier — overall subsystem health
 *   - RegionAwareness       — passive regions must report not-ready for
 *                              write traffic
 *   - OTel exporter health  — exporter being down is a *partial* signal
 *                              (does not flip ready=false) but is surfaced
 *                              in the response body for visibility
 *
 * Response shape is stable: HTTP 200 with `{ready: true, ...}` or HTTP 503
 * with `{ready: false, ...}`. Operators can wire this directly to k8s
 * readinessProbe without parsing the body.
 */

import type { DegradationClassifier, DegradationSnapshot } from "./degradationClassifier.js";
import { getRegionAwareness } from "./regionAwareness.js";
import { getExporterHealth } from "../../telemetry/otelBootstrap.js";

export interface ReadinessReport {
  ready: boolean;
  level: DegradationSnapshot["level"];
  region: {
    regionId: string;
    role: string;
    fencingToken: number;
  };
  otelExporter: {
    healthy: boolean;
    lastFailureAt?: string;
  };
  subsystems: DegradationSnapshot["subsystems"];
  /** Stable contract field — true if the LB should send traffic now. */
  serveTraffic: boolean;
  reasons: string[];
}

export class ReadinessProbe {
  constructor(private readonly degradation: DegradationClassifier) {}

  evaluate(nowMs: number = Date.now()): ReadinessReport {
    const snap = this.degradation.snapshot(nowMs);
    const region = getRegionAwareness().topology();
    const otel = getExporterHealth();

    const reasons: string[] = [];
    let ready = snap.readyForTraffic;
    if (!snap.readyForTraffic) reasons.push(`degradation:${snap.level}`);

    // A passive region MAY still serve read traffic but is never ready for
    // write traffic — operators expose this via a separate `serveTraffic`
    // flag so a region-aware LB can route accordingly.
    let serveTraffic = ready;
    if (region.role === "passive") {
      serveTraffic = false;
      reasons.push("region:passive");
    } else if (region.role === "degraded") {
      reasons.push("region:degraded");
    }

    return {
      ready,
      level: snap.level,
      region: {
        regionId: region.regionId,
        role: region.role,
        fencingToken: region.fencingToken
      },
      otelExporter: {
        healthy: otel.healthy,
        ...(otel.lastFailure
          ? { lastFailureAt: new Date(otel.lastFailure.at).toISOString() }
          : {})
      },
      subsystems: snap.subsystems,
      serveTraffic,
      reasons
    };
  }
}
