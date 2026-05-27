import { defineConfig } from "vitest/config";

/**
 * Integration vitest config — kept separate from the default unit test run
 * so `npm test` stays Docker-free and fast.
 *
 * The hooks below give each suite ~2 minutes for container startup +
 * 1000-event concurrent load; tune via INTEGRATION_TEST_TIMEOUT_MS if your
 * machine is slow.
 */
const timeout = Number(process.env.INTEGRATION_TEST_TIMEOUT_MS ?? 120_000);

export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.test.ts"],
    // Single-threaded by default — container startup dominates wall time,
    // and most suites are already exercising parallelism *within* the test.
    // Set INTEGRATION_PARALLEL=1 to fan out per-suite containers.
    pool: process.env.INTEGRATION_PARALLEL === "1" ? "threads" : "forks",
    poolOptions: {
      forks: { singleFork: process.env.INTEGRATION_PARALLEL !== "1" }
    },
    testTimeout: timeout,
    hookTimeout: timeout,
    teardownTimeout: timeout,
    reporters: ["default"],
    sequence: { shuffle: false },
    // Pass through env so harness can pick up DEBUG_INTEGRATION etc.
    env: process.env as Record<string, string>
  }
});
