/**
 * startupSelfCheck.test.ts — verifies the post-listen route verification.
 *
 * The self-check exercises the critical routes via app.inject() and decides
 * whether the boot is healthy. A route "responds" when status < 500; a 5xx or a
 * thrown injection on a REQUIRED route fails the check; non-required routes
 * (e.g. /ready) never fail it.
 */

import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  runStartupSelfCheck,
  defaultStartupProbes,
  type SelfCheckProbe
} from "../src/infrastructure/reliability/startupSelfCheck.js";

/** Build a fake Fastify whose inject() returns canned codes keyed by url. */
function fakeApp(codes: Record<string, number | "throw">): FastifyInstance {
  return {
    inject: vi.fn(async ({ url }: { url: string }) => {
      const code = codes[url];
      if (code === "throw") throw new Error(`inject failed for ${url}`);
      return { statusCode: code ?? 200 };
    })
  } as unknown as FastifyInstance;
}

const probes: SelfCheckProbe[] = [
  { name: "health", method: "GET", url: "/health", required: true },
  { name: "agents", method: "GET", url: "/agents", required: true },
  { name: "cognition", method: "GET", url: "/cognition", required: true },
  { name: "ready", method: "GET", url: "/ready", required: false }
];

describe("runStartupSelfCheck", () => {
  it("passes when every required route responds < 500", async () => {
    const app = fakeApp({ "/health": 200, "/agents": 200, "/cognition": 200, "/ready": 503 });
    const report = await runStartupSelfCheck(app, probes);
    expect(report.ok).toBe(true);
    expect(report.failed).toHaveLength(0);
    // 4xx still counts as "responds" — prove it does not fail the check.
    const ready = report.probes.find((p) => p.name === "ready")!;
    expect(ready.ok).toBe(false); // 503 is not ok
    expect(ready.required).toBe(false); // but not required, so report stays ok
  });

  it("fails when a REQUIRED route returns 5xx", async () => {
    const app = fakeApp({ "/health": 200, "/agents": 500, "/cognition": 200, "/ready": 200 });
    const report = await runStartupSelfCheck(app, probes);
    expect(report.ok).toBe(false);
    expect(report.failed.map((f) => f.name)).toContain("agents");
  });

  it("fails when a REQUIRED route injection throws", async () => {
    const app = fakeApp({ "/health": 200, "/agents": 200, "/cognition": "throw", "/ready": 200 });
    const report = await runStartupSelfCheck(app, probes);
    expect(report.ok).toBe(false);
    const cog = report.failed.find((f) => f.name === "cognition")!;
    expect(cog.statusCode).toBeNull();
    expect(cog.error).toContain("inject failed");
  });

  it("treats 4xx as responding (route is wired, just rejecting)", async () => {
    const app = fakeApp({ "/health": 401, "/agents": 200, "/cognition": 200, "/ready": 200 });
    const report = await runStartupSelfCheck(app, probes);
    expect(report.ok).toBe(true);
  });

  it("ships a sensible default probe set covering the dashboard's routes", () => {
    const urls = defaultStartupProbes().map((p) => p.url);
    expect(urls).toEqual(
      expect.arrayContaining(["/health", "/agents", "/cognition", "/observability/overview"])
    );
  });
});
