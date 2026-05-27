/**
 * Phase 6 — Certification report generator.
 *
 * Reads chaos-results.json (populated by phase1..5 test runs in this same
 * vitest invocation) and writes:
 *   - docs/chaos-certification-report.json  — machine-readable
 *   - docs/chaos-certification-report.md    — human-readable
 *
 * Scoring (operational readiness):
 *   - Every expected scenario contributes 1 point.
 *   - A passing scenario gets full credit.
 *   - A failing scenario gets 0 (and is enumerated in "residual failure modes").
 *   - A scenario that NEVER RAN is marked "unverified" and gets 0. Unverified
 *     scenarios count against the score — silence is not success.
 *
 * The final score is reported as both a 0..100 percentage AND a letter grade.
 * The threshold for "certified" is ≥ 95%; below that the report carries an
 * explicit DO-NOT-CERTIFY banner.
 */

import { describe, expect, it } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadResults, type PhaseResult } from "./_setup/chaosResultBus.js";
import { chaosEnvironmentSnapshot } from "../../src/infrastructure/chaos/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// chaos → test → api → apps → repo-root
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const REPORT_JSON = resolve(REPO_ROOT, "docs", "chaos-certification-report.json");
const REPORT_MD = resolve(REPO_ROOT, "docs", "chaos-certification-report.md");

const EXPECTED_SCENARIOS: Array<{ key: string; phase: number; label: string }> = [
  { key: "phase1.1.latencySpikes", phase: 1, label: "Redis latency spikes — queue still drains" },
  { key: "phase1.2.disconnectStorm", phase: 1, label: "Redis disconnect storms — every job delivered" },
  { key: "phase1.3.pubsubDrop", phase: 1, label: "Redis partial pub/sub failure — loss observable, bus survives" },
  { key: "phase1.4.delayedAck", phase: 1, label: "Redis delayed acks — no duplicate, no receipt leak" },
  { key: "phase1.5.recoveryAfterReconnect", phase: 1, label: "Redis queue recovery after reconnect" },
  { key: "phase2.1.transientDisconnect", phase: 2, label: "Postgres transient disconnect → recovery" },
  { key: "phase2.2.statementTimeoutExhaustion", phase: 2, label: "Postgres statement_timeout exhaustion — pool intact" },
  { key: "phase2.3.poolStarvation", phase: 2, label: "Postgres pool starvation under load — drains, no leak" },
  { key: "phase2.4.recoveryAfterClear", phase: 2, label: "Postgres recovery after fault clears" },
  { key: "phase2.5.noLeakedClients", phase: 2, label: "Postgres compound fault burst — no client leak" },
  { key: "phase3.1.killMidExecution", phase: 3, label: "Worker kill mid-execution — lease reclaimable" },
  { key: "phase3.2.leaseFencing", phase: 3, label: "Worker lease fencing correctness" },
  { key: "phase3.3.poisonPill", phase: 3, label: "Worker poison-pill → DLQ" },
  { key: "phase3.4.replayRecovery", phase: 3, label: "Worker replay recovery via fresh acquire" },
  { key: "phase3.5.noDuplicateCommit", phase: 3, label: "Worker no-duplicate-commit under contention" },
  { key: "phase4.1.reconnectStorm", phase: 4, label: "SSE reconnect storm — dedupe holds, bounded memory" },
  { key: "phase4.2.droppedTokenStream", phase: 4, label: "SSE dropped tokens — resume fills gap deterministically" },
  { key: "phase4.3.partialReplayBuffer", phase: 4, label: "SSE partial replay buffer — no drop/duplicate" },
  { key: "phase4.4.dedupeCorrectness", phase: 4, label: "SSE dedup correctness" },
  { key: "phase4.5.eventualConsistency", phase: 4, label: "SSE eventual consistency across subscribers" },
  { key: "phase5.1.queueSaturation", phase: 5, label: "Load shedding — backpressure raised over threshold" },
  { key: "phase5.2.responseShape", phase: 5, label: "Load shedding — 503 response shape contract" },
  { key: "phase5.3.retryAfterFormula", phase: 5, label: "Load shedding — Retry-After bounded + monotone" },
  { key: "phase5.4.noCascadingCrash", phase: 5, label: "Load shedding — no cascading crash" },
  { key: "phase5.5.tenantFairness", phase: 5, label: "Load shedding — tenant FIFO baseline (no starvation)" }
];

interface Verdict {
  key: string;
  phase: number;
  label: string;
  status: "pass" | "fail" | "unverified";
  durationMs?: number;
  notes?: string;
  thresholds?: PhaseResult["thresholds"];
}

function letterGrade(score100: number): string {
  if (score100 >= 95) return "A";
  if (score100 >= 90) return "A-";
  if (score100 >= 85) return "B+";
  if (score100 >= 80) return "B";
  if (score100 >= 70) return "C";
  if (score100 >= 60) return "D";
  return "F";
}

describe("Phase 6 — certification report", () => {
  it("aggregates phase results and writes docs/chaos-certification-report.{json,md}", async () => {
    const results = await loadResults();
    const env = chaosEnvironmentSnapshot();

    const verdicts: Verdict[] = EXPECTED_SCENARIOS.map((s) => {
      const r = results.phases[s.key];
      if (!r) {
        return { key: s.key, phase: s.phase, label: s.label, status: "unverified" as const };
      }
      return {
        key: s.key,
        phase: s.phase,
        label: s.label,
        status: r.ok ? ("pass" as const) : ("fail" as const),
        durationMs: r.durationMs,
        ...(r.notes !== undefined ? { notes: r.notes } : {}),
        thresholds: r.thresholds
      };
    });

    const passed = verdicts.filter((v) => v.status === "pass").length;
    const failed = verdicts.filter((v) => v.status === "fail").length;
    const unverified = verdicts.filter((v) => v.status === "unverified").length;
    const total = verdicts.length;
    const score100 = total === 0 ? 0 : Math.round((passed / total) * 100);
    const grade = letterGrade(score100);
    const certified = score100 >= 95 && unverified === 0;

    const residual = verdicts
      .filter((v) => v.status !== "pass")
      .map((v) => ({
        key: v.key,
        phase: v.phase,
        label: v.label,
        status: v.status,
        ...(v.thresholds ? { failingThresholds: Object.entries(v.thresholds).filter(([, t]) => !t.pass).map(([k]) => k) } : {})
      }));

    const report = {
      generatedAt: new Date().toISOString(),
      environment: env,
      chaosResultsStartedAt: results.startedAt,
      chaosResultsUpdatedAt: results.updatedAt,
      score: { passed, failed, unverified, total, score100, grade, certified },
      verdicts,
      residualFailureModes: residual
    };

    await mkdir(dirname(REPORT_JSON), { recursive: true });
    await writeFile(REPORT_JSON, JSON.stringify(report, null, 2), "utf8");

    const md = renderMarkdown(report);
    await writeFile(REPORT_MD, md, "utf8");

    // The Phase 6 test ITSELF does not fail on residual risks — it only fails
    // if the report cannot be written, or if no scenarios ran at all (which
    // would silently produce a 0/0 = vacuous report). Operators read the
    // report; the report does not gate CI by itself.
    expect(verdicts.length).toBeGreaterThan(0);
    expect(report.score.total).toBeGreaterThan(0);
  });
});

function renderMarkdown(report: {
  generatedAt: string;
  environment: ReturnType<typeof chaosEnvironmentSnapshot>;
  score: { passed: number; failed: number; unverified: number; total: number; score100: number; grade: string; certified: boolean };
  verdicts: Verdict[];
  residualFailureModes: Array<{ key: string; phase: number; label: string; status: string; failingThresholds?: string[] }>;
}): string {
  const lines: string[] = [];
  lines.push("# Chaos & Survivability Certification Report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Environment: NODE_ENV=${report.environment.nodeEnv} | CHAOS_ENABLED=${report.environment.enabled} | envFile=${report.environment.envFile ?? "(ambient)"}`);
  lines.push("");
  if (!report.score.certified) {
    lines.push("> **DO NOT CERTIFY.** One or more scenarios failed or did not run.");
    lines.push("> Review the residual-failure-modes section before claiming production readiness.");
    lines.push("");
  }
  lines.push(`## Operational Readiness Score: **${report.score.score100} / 100 (${report.score.grade})**`);
  lines.push("");
  lines.push(`- Passed: **${report.score.passed}** / ${report.score.total}`);
  lines.push(`- Failed: **${report.score.failed}**`);
  lines.push(`- Unverified (did not run): **${report.score.unverified}**`);
  lines.push(`- Certified (≥95% with zero unverified): **${report.score.certified ? "YES" : "NO"}**`);
  lines.push("");
  lines.push("## Chaos Test Matrix");
  lines.push("");
  lines.push("| Phase | Scenario | Status | Duration |");
  lines.push("|------:|----------|--------|---------:|");
  for (const v of report.verdicts) {
    const icon = v.status === "pass" ? "✓" : v.status === "fail" ? "✗" : "·";
    const dur = v.durationMs != null ? `${v.durationMs} ms` : "—";
    lines.push(`| ${v.phase} | ${v.label} | ${icon} ${v.status} | ${dur} |`);
  }
  lines.push("");

  lines.push("## Survivability Report");
  lines.push("");
  lines.push(`- **Redis** (Phase 1): ${summarisePhase(report.verdicts, 1)}`);
  lines.push(`- **Postgres** (Phase 2): ${summarisePhase(report.verdicts, 2)}`);
  lines.push(`- **Workers** (Phase 3): ${summarisePhase(report.verdicts, 3)}`);
  lines.push(`- **SSE** (Phase 4): ${summarisePhase(report.verdicts, 4)}`);
  lines.push(`- **Load shedding** (Phase 5): ${summarisePhase(report.verdicts, 5)}`);
  lines.push("");

  lines.push("## Replay Consistency Verification");
  lines.push("");
  lines.push("Replay consistency is jointly validated by Phase 3.4 (lease-handoff allows a fresh worker to acquire) and the pre-existing integration suites under `test/integration/postgres/replayDeterminism.integration.test.ts` and `chaos.integration.test.ts`. The chaos layer does not re-test fingerprint determinism — that is owned by the integration suite.");
  lines.push("");

  lines.push("## Distributed Correctness Report");
  lines.push("");
  lines.push("Phase 3.5 verifies that 32 concurrent acquires for the same execution yield exactly one owner — i.e., the `FOR UPDATE SKIP LOCKED` invariant in `PostgresLeaseStore` is intact under contention. Combined with the lease-fencing assertions in Phase 3.2, this is the operational floor for at-least-once-with-deduplication processing.");
  lines.push("");

  lines.push("## Resource Exhaustion Analysis");
  lines.push("");
  lines.push("Phase 2.5 verifies that under a compound fault burst (disconnect + statement timeout + pool starvation, each at 0.3 probability over 50 operations), `pgClient.stats().outstanding === 0` at the end of the run. This is the chaos-layer's check that the existing `acquire()` leak-detection works AS DESIGNED under adversarial inputs.");
  lines.push("");

  lines.push("## Residual Failure Modes");
  lines.push("");
  if (report.residualFailureModes.length === 0) {
    lines.push("None observed in this run.");
  } else {
    for (const r of report.residualFailureModes) {
      const ft = r.failingThresholds && r.failingThresholds.length > 0
        ? ` — failing thresholds: ${r.failingThresholds.join(", ")}`
        : "";
      lines.push(`- **Phase ${r.phase}** · ${r.label} · **${r.status}**${ft}`);
    }
  }
  lines.push("");

  lines.push("## Methodology & Honesty Disclosures");
  lines.push("");
  lines.push("- All scenarios run against the real production classes (`RedisExecutionJobQueue`, `RedisEventBus`, `PostgresLeaseStore`, `PostgresDeadLetterStore`, `PgClient`, `RecentSequenceTracker`, `LiveEventBroadcaster`). No mocks.");
  lines.push("- Fault injection is performed by `redisChaosProxy` and `pgChaosProxy`, which are JS `Proxy` wrappers applied at the client factory level. They add delay or short-circuit specific commands — they never fabricate responses.");
  lines.push("- The chaos layer is INERT unless `CHAOS_ENABLED=true` and `NODE_ENV ∉ {production, staging}`. Both gates are checked at every call site.");
  lines.push("- An `unverified` row is one whose result was never written to `chaos-results.json` in this run. It is counted against the score because silence is not evidence of correctness.");
  lines.push("- Phase 5.5 documents that the queue is single-FIFO. Weighted-fair queuing across tenants is enforced upstream by `QuotaEnforcer` and `rateLimiter`, not by the queue itself.");
  lines.push("");

  return lines.join("\n");
}

function summarisePhase(verdicts: Verdict[], phase: number): string {
  const subset = verdicts.filter((v) => v.phase === phase);
  const pass = subset.filter((v) => v.status === "pass").length;
  const fail = subset.filter((v) => v.status === "fail").length;
  const unv = subset.filter((v) => v.status === "unverified").length;
  return `${pass}/${subset.length} passed${fail > 0 ? `, ${fail} failed` : ""}${unv > 0 ? `, ${unv} unverified` : ""}`;
}
