import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Minimal component-test config for the web package. We render components with
 * react-dom/server (renderToStaticMarkup) so no jsdom/testing-library is
 * required — keeps the dependency footprint at zero new runtime packages while
 * still proving that observability identifiers reach the DOM output.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": root
    }
  },
  esbuild: {
    jsx: "automatic"
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"]
  }
});
