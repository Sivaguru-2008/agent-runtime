/**
 * V3 — Reliability wiring glue.
 *
 * Composition root for the V3 reliability subsystems: SloGovernor,
 * DeployFreezeController, DegradationClassifier, ReadinessProbe,
 * IncidentCorrelator. Bundled together so the RuntimeContainer can hold
 * one field rather than five and the operator routes can take one
 * dependency.
 *
 * Why a glue module and not inline construction:
 *   - The wiring needs to hook RegionAwareness transitions and OTel
 *     exporter health into the metrics layer. Doing that inline in the
 *     RuntimeContainer would bloat an already-large file.
 *   - Tests build the same wiring against fakes; centralizing it keeps
 *     the unit test surface coherent.
 */

import type pino from "pino";
import { SloGovernor, defaultSloLadder } from "./sloGovernor.js";
import { DeployFreezeController } from "./deployFreeze.js";
import { DegradationClassifier } from "./degradationClassifier.js";
import { ReadinessProbe } from "./readinessProbe.js";
import { IncidentCorrelator } from "./incidentCorrelation.js";
import { getRegionAwareness } from "./regionAwareness.js";
import { onExporterHealthChange } from "../../telemetry/otelBootstrap.js";
import type { AgentMetrics } from "../metrics/prometheusMetrics.js";

export interface ReliabilityWiring {
  slo: SloGovernor;
  freeze: DeployFreezeController;
  degradation: DegradationClassifier;
  readiness: ReadinessProbe;
  incidents: IncidentCorrelator;
  /** Tear down subscriptions (called on container.close). */
  close(): Promise<void>;
}

export function buildReliabilityWiring(
  metrics: AgentMetrics | undefined,
  logger: pino.Logger,
  opts?: { skipDefaultSlos?: boolean }
): ReliabilityWiring {
  const slo = new SloGovernor();
  if (!opts?.skipDefaultSlos) {
    for (const def of defaultSloLadder()) slo.register(def);
  }
  const freeze = new DeployFreezeController(slo);
  const degradation = new DegradationClassifier();
  const readiness = new ReadinessProbe(degradation);
  const incidents = new IncidentCorrelator(slo, freeze);

  const unsubs: (() => void)[] = [];

  if (metrics) {
    // Region transitions → metrics.
    const region = getRegionAwareness();
    const publishRegion = () => {
      const t = region.topology();
      metrics.regionActive.set({ region: t.regionId }, t.role === "active" ? 1 : 0);
      metrics.regionFencingToken.set({ region: t.regionId }, t.fencingToken);
    };
    publishRegion();
    unsubs.push(
      region.onTransition((t) => {
        publishRegion();
        // Promote/demote/degrade direction inferred from role transition.
        let direction = "degrade";
        if (t.role === "active") direction = "promote";
        else if (t.role === "passive") direction = "demote";
        metrics.regionTransitions.inc({ region: t.regionId, direction });
        logger.warn(
          { region: t.regionId, role: t.role, fencingToken: t.fencingToken, reason: t.reason },
          "[reliability] region transition"
        );
      })
    );

    // OTel exporter health → metrics.
    unsubs.push(
      onExporterHealthChange((h) => {
        metrics.otelExporterHealthy.set(h.healthy ? 1 : 0);
        if (h.backpressureCount > 0) {
          metrics.otelExporterBackpressure.inc(0); // labels unchanged; ensures the counter exists.
        }
      })
    );

    // Degradation level → metrics.
    const levelOrdinal: Record<string, number> = {
      nominal: 0,
      partial: 1,
      critical: 2,
      failed: 3
    };
    unsubs.push(
      degradation.onChange((s) => {
        metrics.runtimeDegradationLevel.set(levelOrdinal[s.level] ?? 0);
      })
    );

    // SLO gauges — published on a slow cadence rather than per-observation.
    const slowTick = setInterval(() => {
      for (const snap of slo.snapshotAll()) {
        metrics.sloBudgetConsumed.set(
          { slo: snap.name, kind: snap.kind },
          isFinite(snap.budgetConsumed) ? Math.min(snap.budgetConsumed, 10) : 10
        );
        for (const b of snap.burns) {
          metrics.sloBurnRate.set(
            { slo: snap.name, window: b.label },
            isFinite(b.burnRate) ? Math.min(b.burnRate, 1e6) : 1e6
          );
        }
      }
      const decision = freeze.decision();
      metrics.deployFreezeActive.set({ source: decision.source }, decision.frozen ? 1 : 0);
    }, 10_000);
    slowTick.unref?.();
    unsubs.push(() => clearInterval(slowTick));
  }

  return {
    slo,
    freeze,
    degradation,
    readiness,
    incidents,
    async close() {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          // ignore — close path must never throw.
        }
      }
    }
  };
}
