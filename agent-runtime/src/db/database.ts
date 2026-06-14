/**
 * The single SQLite database. All eight stages write here; everything is
 * connected by `runId` (Non-Negotiables: "One schema. One database.").
 *
 * Backed by the built-in `node:sqlite` module so the package needs no native
 * build step. The agent-fence committed-effects log lives in the SAME database
 * (see fenceStore.ts), so a tool call and the fence decision that governed it
 * are one JOIN apart.
 */
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncHandle } from "node:sqlite";
import type {
  CausalChain,
  FaultType,
  FenceEvent,
  FinalEvaluation,
  Intervention,
  PreFlightAnalysis,
  RunContext,
  StepValidation,
  StreamSignal,
} from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  prompt        TEXT NOT NULL,
  intent        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  final_response TEXT,
  verdict       TEXT,
  total_cost_usd      REAL DEFAULT 0,
  damage_prevented_usd REAL DEFAULT 0,
  duration_ms   INTEGER DEFAULT 0,
  aborted       INTEGER DEFAULT 0,
  data          TEXT
);

CREATE TABLE IF NOT EXISTS preflight_analyses (
  run_id      TEXT PRIMARY KEY,
  risk_score  INTEGER NOT NULL,
  complexity  TEXT NOT NULL,
  should_proceed INTEGER NOT NULL,
  predictions TEXT NOT NULL,
  data        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stream_signals (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  token_index INTEGER NOT NULL,
  step        INTEGER NOT NULL,
  signal_type TEXT NOT NULL,
  severity    TEXT NOT NULL,
  evidence    TEXT NOT NULL,
  data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_run ON stream_signals(run_id);

CREATE TABLE IF NOT EXISTS step_validations (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  step        INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  input_hash  TEXT NOT NULL,
  quality     INTEGER NOT NULL,
  silent_failure INTEGER NOT NULL,
  fence_decision TEXT NOT NULL,
  data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON step_validations(run_id);

CREATE TABLE IF NOT EXISTS fence_events (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  step        INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  decision    TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  recorded_response TEXT,
  reason      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fence_run ON fence_events(run_id);

CREATE TABLE IF NOT EXISTS interventions (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  step        INTEGER NOT NULL,
  type        TEXT NOT NULL,
  action      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interventions_run ON interventions(run_id);

CREATE TABLE IF NOT EXISTS causal_chains (
  run_id        TEXT PRIMARY KEY,
  failure_type  TEXT NOT NULL,
  root_cause    TEXT NOT NULL,
  chain         TEXT NOT NULL,
  data          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS final_evaluations (
  run_id        TEXT PRIMARY KEY,
  verdict       TEXT NOT NULL,
  completeness  INTEGER NOT NULL,
  accuracy      INTEGER NOT NULL,
  confidence    INTEGER NOT NULL,
  prevented     TEXT NOT NULL,
  data          TEXT NOT NULL
);

-- Per-fault rows feeding the pattern learner. One row per (run, faultType).
CREATE TABLE IF NOT EXISTS run_faults (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  fault_type        TEXT NOT NULL,
  prevented_by_fence INTEGER NOT NULL,
  cost_of_damage    REAL NOT NULL,
  cost_of_intervention REAL NOT NULL,
  pre_flight_predicted INTEGER NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faults_type ON run_faults(fault_type);

CREATE TABLE IF NOT EXISTS pattern_aggregates (
  fault_type    TEXT PRIMARY KEY,
  occurrences   INTEGER NOT NULL,
  fence_help_rate REAL NOT NULL,
  avg_damage_usd REAL NOT NULL,
  avg_intervention_usd REAL NOT NULL,
  prediction_accuracy REAL NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Pre-flight accuracy snapshot per run, so we can show the trend over time.
CREATE TABLE IF NOT EXISTS preflight_scores (
  run_id      TEXT PRIMARY KEY,
  predicted   INTEGER NOT NULL,
  hit         INTEGER NOT NULL,
  accuracy    REAL NOT NULL,
  created_at  TEXT NOT NULL
);
`;

// Load node:sqlite through a runtime require so bundlers that don't yet know
// the module (Vite/vitest) never try to transform it. tsx/tsc see the
// type-only import above and resolve types from types/node-sqlite.d.ts.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

export class RuntimeDB {
  readonly handle: DatabaseSyncHandle;

  constructor(path = "agent-runtime.db") {
    this.handle = new DatabaseSync(path);
    this.handle.exec("PRAGMA journal_mode = WAL;");
    this.handle.exec(SCHEMA);
  }

  close(): void {
    this.handle.close();
  }

  // ── Stage 0/1: run row + pre-flight ───────────────────────────────────────

  startRun(runId: string, prompt: string, intentJson: string, startedAt: string): void {
    this.handle
      .prepare(
        `INSERT OR REPLACE INTO runs (run_id, prompt, intent, started_at) VALUES (?, ?, ?, ?)`
      )
      .run(runId, prompt, intentJson, startedAt);
  }

  storePreflight(runId: string, pf: PreFlightAnalysis): void {
    this.handle
      .prepare(
        `INSERT OR REPLACE INTO preflight_analyses
         (run_id, risk_score, complexity, should_proceed, predictions, data)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        pf.riskScore,
        pf.complexity,
        pf.shouldProceed ? 1 : 0,
        JSON.stringify(pf.predictedFailures),
        JSON.stringify(pf)
      );
  }

  // ── Stage 2: stream signals ───────────────────────────────────────────────

  storeSignal(s: StreamSignal): void {
    this.handle
      .prepare(
        `INSERT INTO stream_signals
         (id, run_id, token_index, step, signal_type, severity, evidence, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id("sig"), s.runId, s.tokenIndex, s.detectedAtStep, s.type, s.severity, s.evidence, JSON.stringify(s));
  }

  // ── Stage 3: step validations ─────────────────────────────────────────────

  storeStepValidation(runId: string, v: StepValidation): void {
    this.handle
      .prepare(
        `INSERT INTO step_validations
         (id, run_id, step, tool, input_hash, quality, silent_failure, fence_decision, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id("step"),
        runId,
        v.stepNumber,
        v.toolCalled,
        v.inputHash,
        v.dataQualityScore,
        v.silentFailureDetected ? 1 : 0,
        v.fenceDecision,
        JSON.stringify(v)
      );
  }

  // ── Stage 4: fence events ─────────────────────────────────────────────────

  storeFenceEvent(e: FenceEvent): void {
    this.handle
      .prepare(
        `INSERT INTO fence_events
         (id, run_id, step, tool, decision, operation_id, recorded_response, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id("fe"), e.runId, e.step, e.tool, e.decision, e.operationId, e.recordedResponse ?? null, e.reason);
  }

  // ── Stage 6: interventions ────────────────────────────────────────────────

  storeIntervention(iv: Intervention): void {
    this.handle
      .prepare(
        `INSERT INTO interventions (id, run_id, step, type, action, reason, outcome, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id("iv"), iv.runId, iv.step, iv.type, iv.action, iv.reason, iv.outcome, JSON.stringify(iv));
  }

  // ── Stage 5: causal chains ────────────────────────────────────────────────

  storeCausalChain(runId: string, c: CausalChain): void {
    this.handle
      .prepare(
        `INSERT OR REPLACE INTO causal_chains (run_id, failure_type, root_cause, chain, data)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(runId, c.failureType, JSON.stringify(c.rootCause), JSON.stringify(c.chain), JSON.stringify(c));
  }

  // ── Stage 8: final evaluations ────────────────────────────────────────────

  storeFinalEvaluation(runId: string, e: FinalEvaluation): void {
    this.handle
      .prepare(
        `INSERT OR REPLACE INTO final_evaluations
         (run_id, verdict, completeness, accuracy, confidence, prevented, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        e.overallVerdict,
        e.completenessScore,
        e.accuracyScore,
        e.confidenceScore,
        JSON.stringify(e.damagePrevented),
        JSON.stringify(e)
      );
  }

  // ── Finalize the run row ──────────────────────────────────────────────────

  finishRun(ctx: RunContext): void {
    this.handle
      .prepare(
        `UPDATE runs SET completed_at = ?, final_response = ?, verdict = ?,
           total_cost_usd = ?, damage_prevented_usd = ?, duration_ms = ?, aborted = ?, data = ?
         WHERE run_id = ?`
      )
      .run(
        ctx.completedAt,
        ctx.finalResponse,
        ctx.finalEvaluation.overallVerdict,
        ctx.totalCostUSD,
        ctx.damagePreventedUSD,
        ctx.durationMs,
        ctx.aborted ? 1 : 0,
        JSON.stringify(ctx),
        ctx.runId
      );
  }

  // ── Stage 7: pattern learner storage ──────────────────────────────────────

  recordFault(args: {
    runId: string;
    faultType: FaultType;
    preventedByFence: boolean;
    costOfDamage: number;
    costOfIntervention: number;
    preFlightPredicted: boolean;
  }): void {
    this.handle
      .prepare(
        `INSERT INTO run_faults
         (id, run_id, fault_type, prevented_by_fence, cost_of_damage,
          cost_of_intervention, pre_flight_predicted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id("flt"),
        args.runId,
        args.faultType,
        args.preventedByFence ? 1 : 0,
        args.costOfDamage,
        args.costOfIntervention,
        args.preFlightPredicted ? 1 : 0,
        new Date().toISOString()
      );
  }

  recordPreflightScore(runId: string, predicted: number, hit: number, accuracy: number): void {
    this.handle
      .prepare(
        `INSERT OR REPLACE INTO preflight_scores (run_id, predicted, hit, accuracy, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(runId, predicted, hit, accuracy, new Date().toISOString());
  }

  upsertPatternAggregate(row: {
    faultType: FaultType;
    occurrences: number;
    fenceHelpRate: number;
    avgDamageUSD: number;
    avgInterventionUSD: number;
    predictionAccuracy: number;
  }): void {
    this.handle
      .prepare(
        `INSERT OR REPLACE INTO pattern_aggregates
         (fault_type, occurrences, fence_help_rate, avg_damage_usd, avg_intervention_usd,
          prediction_accuracy, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.faultType,
        row.occurrences,
        row.fenceHelpRate,
        row.avgDamageUSD,
        row.avgInterventionUSD,
        row.predictionAccuracy,
        new Date().toISOString()
      );
  }

  // ── Aggregate reads for Stage 7 / the panel ───────────────────────────────

  aggregateFaults(): Array<{
    fault_type: string;
    occurrences: number;
    fence_help_rate: number;
    avg_damage_usd: number;
    avg_intervention_usd: number;
    prediction_accuracy: number;
  }> {
    return this.handle
      .prepare(
        `SELECT
           fault_type,
           COUNT(*) AS occurrences,
           AVG(prevented_by_fence) AS fence_help_rate,
           AVG(cost_of_damage) AS avg_damage_usd,
           AVG(cost_of_intervention) AS avg_intervention_usd,
           AVG(pre_flight_predicted) AS prediction_accuracy
         FROM run_faults
         GROUP BY fault_type
         ORDER BY occurrences DESC`
      )
      .all() as any[];
  }

  /** Occurrences in the most recent `window` runs vs the prior window. */
  faultTrend(faultType: string, window: number): { recent: number; prior: number } {
    const recentRuns = this.handle
      .prepare(`SELECT run_id FROM runs ORDER BY started_at DESC LIMIT ?`)
      .all(window * 2) as Array<{ run_id: string }>;
    const recentIds = new Set(recentRuns.slice(0, window).map((r) => r.run_id));
    const priorIds = new Set(recentRuns.slice(window).map((r) => r.run_id));
    const rows = this.handle
      .prepare(`SELECT run_id FROM run_faults WHERE fault_type = ?`)
      .all(faultType) as Array<{ run_id: string }>;
    let recent = 0;
    let prior = 0;
    for (const r of rows) {
      if (recentIds.has(r.run_id)) recent += 1;
      else if (priorIds.has(r.run_id)) prior += 1;
    }
    return { recent, prior };
  }

  preflightAccuracy(): { overall: number; recent: number; prior: number } {
    const all = this.handle.prepare(`SELECT accuracy FROM preflight_scores ORDER BY created_at ASC`).all() as Array<{
      accuracy: number;
    }>;
    const overall = all.length ? all.reduce((s, r) => s + r.accuracy, 0) / all.length : 0;
    const half = Math.floor(all.length / 2);
    const prior = half ? avg(all.slice(0, half).map((r) => r.accuracy)) : overall;
    const recent = half ? avg(all.slice(half).map((r) => r.accuracy)) : overall;
    return { overall, recent, prior };
  }

  fenceCounts(): { committed: number; suppressed: number; total: number; saveRate: number } {
    const row = this.handle
      .prepare(
        `SELECT
           SUM(CASE WHEN decision = 'SUPPRESSED' THEN 1 ELSE 0 END) AS suppressed,
           SUM(CASE WHEN decision = 'COMMITTED' THEN 1 ELSE 0 END) AS committed,
           COUNT(*) AS total
         FROM fence_events`
      )
      .get() as { suppressed: number | null; committed: number | null; total: number | null };
    const total = row.total ?? 0;
    const suppressed = row.suppressed ?? 0;
    return { committed: row.committed ?? 0, suppressed, total, saveRate: total ? suppressed / total : 0 };
  }

  countRuns(): number {
    const row = this.handle.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number };
    return row.n;
  }

  /** Reload a fully-finished run for rendering / inspection. */
  loadRun(runId: string): RunContext | null {
    const row = this.handle.prepare(`SELECT data FROM runs WHERE run_id = ?`).get(runId) as
      | { data: string | null }
      | undefined;
    if (!row?.data) return null;
    return JSON.parse(row.data) as RunContext;
  }
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
