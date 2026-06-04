/**
 * startupSelfCheck — post-listen verification that the API can actually serve.
 *
 * "Server listening at 0.0.0.0:4000" only proves the socket bound. It does not
 * prove the route tree is wired, the DB-backed read paths work, or that the
 * observability endpoints the frontend polls will answer. This self-check runs
 * immediately after `app.listen()` and exercises the critical routes via
 * `app.inject()` — an in-process request that needs no network and no open
 * port — so a boot that "succeeds" but cannot answer /health, /agents,
 * /cognition, or /observability is caught at startup instead of surfacing later
 * as a browser ERR_CONNECTION_REFUSED / blank dashboard.
 *
 * A route "responds" when it returns any status < 500. A 5xx (or an injection
 * that throws) means the route is wired wrong or its backing read path is
 * broken — that is a real startup failure. 4xx is treated as "responds"
 * because auth/validation rejections still prove the route is alive.
 */

import type { FastifyInstance } from "fastify";

export interface SelfCheckProbe {
  /** Human label for logs. */
  name: string;
  method: "GET" | "POST";
  url: string;
  /**
   * When true, a failure of this probe fails the whole self-check. When false
   * the probe is informational only (e.g. /ready can legitimately be 503 when
   * a downstream dependency is momentarily unavailable — that is not a wiring
   * bug). Defaults to true.
   */
  required?: boolean;
}

export interface ProbeResult {
  name: string;
  url: string;
  ok: boolean;
  statusCode: number | null;
  required: boolean;
  durationMs: number;
  error?: string;
}

export interface SelfCheckReport {
  ok: boolean;
  durationMs: number;
  probes: ProbeResult[];
  failed: ProbeResult[];
}

/** The default route set verified at boot. */
export function defaultStartupProbes(): SelfCheckProbe[] {
  return [
    { name: "health", method: "GET", url: "/health", required: true },
    { name: "live", method: "GET", url: "/live", required: true },
    { name: "ready", method: "GET", url: "/ready", required: false },
    { name: "agents", method: "GET", url: "/agents", required: true },
    { name: "cognition", method: "GET", url: "/cognition", required: true },
    { name: "observability.overview", method: "GET", url: "/observability/overview", required: true },
    { name: "observability.topology", method: "GET", url: "/observability/topology", required: false },
    { name: "metrics", method: "GET", url: "/metrics", required: false }
  ];
}

/**
 * Run the self-check. Never throws — failures are reported in the returned
 * structure so the caller decides whether to abort the boot (strict) or log
 * loudly and continue (development).
 */
export async function runStartupSelfCheck(
  app: FastifyInstance,
  probes: SelfCheckProbe[] = defaultStartupProbes()
): Promise<SelfCheckReport> {
  const overallStart = performance.now();
  const results: ProbeResult[] = [];

  for (const probe of probes) {
    const required = probe.required !== false;
    const start = performance.now();
    try {
      const res = await app.inject({ method: probe.method, url: probe.url });
      const durationMs = Math.round(performance.now() - start);
      const ok = res.statusCode < 500;
      const result: ProbeResult = {
        name: probe.name,
        url: probe.url,
        ok,
        statusCode: res.statusCode,
        required,
        durationMs
      };
      if (!ok) result.error = `HTTP ${res.statusCode}`;
      results.push(result);
    } catch (err) {
      results.push({
        name: probe.name,
        url: probe.url,
        ok: false,
        statusCode: null,
        required,
        durationMs: Math.round(performance.now() - start),
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const failed = results.filter((r) => r.required && !r.ok);
  return {
    ok: failed.length === 0,
    durationMs: Math.round(performance.now() - overallStart),
    probes: results,
    failed
  };
}
