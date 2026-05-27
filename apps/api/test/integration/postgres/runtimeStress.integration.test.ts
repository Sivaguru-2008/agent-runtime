/**
 * Runtime Determinism Stress Harness — single-container, 20-iteration loop.
 *
 * Pivot rationale: the Docker daemon is flaky on the development workstation,
 * and repeated container teardown/startup amplifies the instability. This
 * harness amortises ONE container startup across the full sweep:
 *
 *   • `tryStartHarness()` is called exactly once at module top-level.
 *   • Each iteration TRUNCATEs the schema (`harness.reset()`) instead of
 *     recreating the container.
 *   • Each iteration captures resource + listener baselines, runs the four
 *     stress phases (ordering / dedupe / replay determinism / reconnect /
 *     latency), then asserts cleanup vs. baseline.
 *   • Per-iteration JSON diagnostics + an aggregated summary land under
 *     `.logs/runtime-stress/<runId>/`.
 *
 * Gating: only runs when `STRESS_RUN=1` is set in the environment, so the
 * default `npm run test:integration` stays cheap. The stress sweep is
 * explicitly opt-in.
 *
 * Exact run command (after Docker Desktop is healthy):
 *
 *   PowerShell:
 *     $env:STRESS_RUN="1"; npm run test:integration -w apps/api -- test/integration/postgres/runtimeStress.integration.test.ts
 *
 *   Bash/Zsh:
 *     STRESS_RUN=1 npm run test:integration -w apps/api -- test/integration/postgres/runtimeStress.integration.test.ts
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tryStartHarness } from "./harness.js";
import { runStressIterations } from "./stress/stressHarness.js";
import { aggregateSummary, createDiagnosticsWriter } from "./stress/diagnostics.js";

const STRESS_GATE = process.env.STRESS_RUN === "1";
const ITERATIONS = Number(process.env.STRESS_ITERATIONS ?? 20);

const HERE = dirname(fileURLToPath(import.meta.url));
// `.logs/` lives at the repo root, two levels above apps/api/test.
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const LOGS_ROOT = resolve(REPO_ROOT, ".logs");

const harness = STRESS_GATE ? await tryStartHarness() : null;

afterAll(async () => {
  if (harness) await harness.stop();
});

describe.skipIf(!STRESS_GATE || !harness)(
  "Runtime determinism stress harness — single persistent container",
  () => {
    it(`runs ${ITERATIONS} iterations and asserts all deterministic invariants hold`, async () => {
      const writer = await createDiagnosticsWriter(LOGS_ROOT);
      // eslint-disable-next-line no-console
      console.log(`[stress] run started — diagnostics dir: ${writer.runDir}`);

      const result = await runStressIterations(harness!, {
        iterations: ITERATIONS,
        runId: writer.runId
      });

      // Write per-iteration JSON regardless of pass/fail.
      for (const diag of result.iterations) {
        await writer.writeIteration(diag);
      }

      if (result.firstFailureSnapshot) {
        await writer.writeFailureSnapshot(result.firstFailureSnapshot);
      }

      const summary = aggregateSummary(
        writer.runId,
        result.iterations,
        result.baselineResources,
        result.finalResources,
        result.finalListeners,
        result.initialListeners
      );
      await writer.writeSummary(summary);

      // eslint-disable-next-line no-console
      console.log(
        `[stress] complete — ${summary.passedIterations}/${summary.iterations} passed, ` +
        `heap growth ${formatBytes(summary.leakIndicators.heapGrowthBytes)}, ` +
        `active-resource growth ${summary.leakIndicators.activeResourceGrowth}`
      );

      // The actual assertion: every iteration's invariants held. We do this
      // in two layers so the failure message names the first offending
      // iteration AND the first offending invariant inside it.
      const firstFail = result.iterations.find((i) => !i.pass);
      if (firstFail) {
        const failedInvariants = firstFail.invariants
          .filter((v) => !v.passed)
          .map((v) => `${v.name}: ${v.detail}`)
          .join("; ");
        expect.fail(
          `Iteration ${firstFail.iteration}/${ITERATIONS} failed: ${failedInvariants}\n` +
          `Failure snapshot: ${writer.runDir}/failure-snapshot.json`
        );
      }
      expect(summary.failedIterations).toBe(0);
    }, 10 * 60_000); // 10 minutes for 20 iterations
  }
);

// Surface a single explanatory line in the default `npm run test:integration`
// run instead of the silent skip — operators need to know the gate exists.
describe.skipIf(STRESS_GATE)("Runtime stress harness (gated)", () => {
  it("skipped — set STRESS_RUN=1 to enable the 20-iteration sweep", () => {
    expect(STRESS_GATE).toBe(false);
  });
});

function formatBytes(n: number): string {
  if (Math.abs(n) < 1024) return `${n}B`;
  if (Math.abs(n) < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${(n / 1024 / 1024).toFixed(2)}MiB`;
}
