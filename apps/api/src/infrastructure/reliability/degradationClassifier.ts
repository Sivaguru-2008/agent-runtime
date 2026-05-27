/**
 * V3 — Runtime degradation classifier.
 *
 * Why:
 *   The platform already had a binary `healthy | degraded | strict-prod-failure`
 *   liveness state. Operators asked for a finer-grained classification so the
 *   /ready probe and dashboards can distinguish "I lost a tool provider"
 *   (partial) from "I cannot reach Postgres" (failed).
 *
 * Levels:
 *   nominal  — every subsystem reporting healthy.
 *   partial  — at least one non-critical subsystem is degraded (e.g. one
 *              provider in a failover chain, OTel exporter offline).
 *              READY remains true.
 *   critical — a critical subsystem is unhealthy (event bus, primary DB).
 *              READY flips to false; traffic should be shifted away.
 *   failed   — multiple critical subsystems unhealthy OR the strict-prod
 *              precondition failed. Restart is unlikely to help; the
 *              orchestrator should back off.
 *
 * Inputs:
 *   Each subsystem reports its health via `report()`. The classifier holds
 *   the most recent report per subsystem and computes an aggregate level.
 *   Reports older than `staleAfterMs` are treated as failed for that
 *   subsystem — a silent worker is presumed broken.
 */

export type DegradationLevel = "nominal" | "partial" | "critical" | "failed";

export type SubsystemCriticality = "core" | "secondary";

export interface SubsystemReport {
  name: string;
  status: "healthy" | "degraded" | "down";
  criticality: SubsystemCriticality;
  message?: string;
  at?: number;
}

export interface DegradationSnapshot {
  level: DegradationLevel;
  readyForTraffic: boolean;
  subsystems: SubsystemReport[];
  /** ISO timestamp of the most recent report received. */
  lastReportAt?: string;
}

export interface DegradationClassifierOptions {
  /** Reports older than this are considered stale and treated as `down`. */
  staleAfterMs?: number;
}

const LEVEL_ORDINAL: Record<DegradationLevel, number> = {
  nominal: 0,
  partial: 1,
  critical: 2,
  failed: 3
};

export class DegradationClassifier {
  private readonly staleAfterMs: number;
  private readonly reports = new Map<string, SubsystemReport>();
  private listeners = new Set<(s: DegradationSnapshot) => void>();

  constructor(opts?: DegradationClassifierOptions) {
    this.staleAfterMs = opts?.staleAfterMs ?? 60_000;
  }

  report(r: SubsystemReport): void {
    this.reports.set(r.name, { ...r, at: r.at ?? Date.now() });
    this.emit();
  }

  /**
   * Mark a subsystem absent (e.g. the OTel exporter has been intentionally
   * disabled). Removes it from the aggregate so it does not bias the level.
   */
  forget(name: string): void {
    if (this.reports.delete(name)) this.emit();
  }

  snapshot(nowMs: number = Date.now()): DegradationSnapshot {
    const subsystems: SubsystemReport[] = [];
    let level: DegradationLevel = "nominal";
    let lastReportAt: number | undefined;
    let coreDown = 0;
    let secondaryDown = 0;
    let degradedOrCoreSecondaryDown = false;

    for (const r of this.reports.values()) {
      const at = r.at ?? 0;
      const effective: SubsystemReport["status"] =
        nowMs - at > this.staleAfterMs ? "down" : r.status;
      subsystems.push({ ...r, status: effective });
      lastReportAt = lastReportAt ? Math.max(lastReportAt, at) : at;

      if (effective === "down") {
        if (r.criticality === "core") coreDown += 1;
        else secondaryDown += 1;
        degradedOrCoreSecondaryDown = true;
      } else if (effective === "degraded") {
        degradedOrCoreSecondaryDown = true;
      }
    }

    if (coreDown >= 2) level = "failed";
    else if (coreDown === 1) level = "critical";
    else if (degradedOrCoreSecondaryDown || secondaryDown > 0) level = "partial";

    return {
      level,
      readyForTraffic: LEVEL_ORDINAL[level] < LEVEL_ORDINAL["critical"],
      subsystems,
      ...(lastReportAt ? { lastReportAt: new Date(lastReportAt).toISOString() } : {})
    };
  }

  onChange(fn: (s: DegradationSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        // listeners must never block reports.
      }
    }
  }
}
