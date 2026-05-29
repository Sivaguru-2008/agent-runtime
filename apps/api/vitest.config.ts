import { defineConfig } from "vitest/config";

/**
 * Default vitest config — unit tests only. Integration tests live under
 * `test/integration/**` and run via `npm run test:integration` (separate
 * config in vitest.integration.config.ts) because they require Docker.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "test/integration/**",
      "test/chaos/**"
    ]
  }
});
