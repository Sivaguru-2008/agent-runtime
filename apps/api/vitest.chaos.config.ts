import { defineConfig } from "vitest/config";

/**
 * Chaos vitest config — kept separate from `vitest.config.ts` and
 * `vitest.integration.config.ts` so:
 *   - `npm test` stays fast and Docker-free.
 *   - The chaos suite forces `CHAOS_ENABLED=true` before any source module
 *     is imported, without leaking that env into the other suites.
 *   - Single-fork execution guarantees the cross-phase chaos-results.json
 *     write/read ordering is deterministic. Phase 6 reads what phases 1–5
 *     wrote in the SAME process.
 *
 * Timeouts default to 3 minutes — each phase can be up to 90s on cold-cache
 * test containers; override with CHAOS_TEST_TIMEOUT_MS for slow machines.
 */
const timeout = Number(process.env.CHAOS_TEST_TIMEOUT_MS ?? 180_000);

export default defineConfig({
  test: {
    include: ["test/chaos/**/*.chaos.test.ts"],
    exclude: ["test/chaos/_setup/**"],
    pool: "forks",
    poolOptions: {
      // Single fork: phases must run in-order so phase 6 can aggregate.
      forks: { singleFork: true }
    },
    sequence: { shuffle: false },
    testTimeout: timeout,
    hookTimeout: timeout,
    teardownTimeout: timeout,
    reporters: ["default"],
    env: {
      ...(process.env as Record<string, string>),
      CHAOS_ENABLED: "true",
      // Pin NODE_ENV=test so the strict-prod guard in chaosConfig.ts refuses
      // to enable chaos in a misconfigured environment that somehow has
      // CHAOS_ENABLED set in production.
      NODE_ENV: "test"
    }
  }
});
