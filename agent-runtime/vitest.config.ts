import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: __dirname,
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The pipeline does real I/O (SQLite, optional network); give it room.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    server: {
      deps: {
        // The agent-fence dist is CommonJS with a lazy native require — load it
        // through Node's real resolver instead of Vite's transform.
        external: [/agent-fence[\\/]dist[\\/]/],
      },
    },
  },
});
