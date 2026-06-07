import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const BACKEND_URL = process.env.RUNTIME_API_URL ?? "http://127.0.0.1:4000";

// Server-side API key for the durable backend. When the backend runs with
// AUTH_ENABLED=true (production, and locally when mirroring it), every non-
// liveness route requires a credential — but the browser never holds one, so
// without this the entire dashboard would 401. This value lives ONLY in the
// Next server runtime (NOT NEXT_PUBLIC_*), so it is injected into the upstream
// request here and never reaches the client bundle. Unset (e.g. local runs with
// AUTH_ENABLED=false) → no header added and the backend uses its dev fallback.
const RUNTIME_API_KEY = process.env.RUNTIME_API_KEY;

// Headers that must NOT be copied from the upstream response onto the re-emitted
// one. `fetch` has already decompressed the body, so the upstream
// Content-Encoding and original Content-Length describe bytes that no longer
// exist and would corrupt the response; the rest are hop-by-hop headers that are
// meaningless across the proxy boundary.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

// "Null body" HTTP statuses: the Web Response/NextResponse constructor throws
// "Invalid response status code" if handed a non-null body for any of these, and
// response.blob() is always a non-null Blob (even when empty). Forward them with
// a null body so a backend 204/205/304 (e.g. POST /auth/visit → 204) proxies
// cleanly instead of crashing the route into an opaque 500.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function sanitizeHeaders(src: Headers): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

type RouteParams = { params: Promise<{ path: string[] }> };

// Liveness/readiness probes are dependency-free on the backend and exist
// precisely to answer "is the backend reachable yet?". They MUST bypass the
// circuit breaker: gating them behind the breaker means a tripped breaker
// answers the recovery probe with a cached CIRCUIT_OPEN without ever touching
// the backend, so the breaker can only re-close if some *other* request happens
// to slip through a half-open window. Letting these paths always reach the
// backend makes the health poll the breaker's recovery driver — the moment the
// backend answers, recordSuccess() closes the breaker for every other route.
const LIVENESS_PATHS = new Set(["/health", "/live", "/ready"]);

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private failures = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold = 5;
  private readonly cooldownMs = 8000; // 8 seconds cooldown

  private transition(to: BreakerState, reason: string, ctx?: string) {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    // Structured, greppable state-transition log: CLOSED->OPEN, OPEN->HALF_OPEN,
    // HALF_OPEN->CLOSED, HALF_OPEN->OPEN. Carries the request context so a
    // transition can be correlated to the exact requestId/traceId/target/status
    // that caused it.
    console.warn(
      `[PROXY_BREAKER_TRANSITION] ${from}->${to} reason=${reason} ` +
        `failures=${this.failures} threshold=${this.failureThreshold} cooldownMs=${this.cooldownMs}` +
        (ctx ? ` ${ctx}` : "")
    );
  }

  public check(ctx?: string): boolean {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.cooldownMs) {
        this.transition("HALF_OPEN", "cooldown_elapsed", ctx);
        return true;
      }
      return false; // Blocked
    }
    return true;
  }

  public recordSuccess(ctx?: string) {
    // A reachable backend (any HTTP response, even 5xx) closes the breaker.
    this.transition("CLOSED", "upstream_reachable", ctx);
    this.failures = 0;
  }

  public recordFailure(ctx?: string) {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.transition("OPEN", `failures>=${this.failureThreshold}`, ctx);
    }
  }

  public getState() {
    return this.state;
  }
}

const globalForBreaker = globalThis as unknown as {
  breaker?: CircuitBreaker;
};

if (!globalForBreaker.breaker) {
  globalForBreaker.breaker = new CircuitBreaker();
}
const breaker = globalForBreaker.breaker;

async function handleProxy(req: NextRequest, pathParts: string[]) {
  const path = "/" + (pathParts ? pathParts.join("/") : "");
  const url = new URL(req.url);
  const targetUrl = `${BACKEND_URL}${path}${url.search}`;

  const method = req.method;
  const headers = new Headers();
  req.headers.forEach((val, key) => {
    if (key.toLowerCase() !== "host") {
      headers.set(key, val);
    }
  });

  // Inject the backend credential server-side. We do NOT override a key the
  // caller already supplied (future per-user keys), only fill the gap for the
  // browser, which has none.
  if (RUNTIME_API_KEY && !headers.has("x-api-key")) {
    headers.set("x-api-key", RUNTIME_API_KEY);
  }

  const requestId = headers.get("x-request-id") || Math.random().toString(36).substring(2, 15);
  const traceId = headers.get("x-trace-id") || Math.random().toString(36).substring(2, 15);
  headers.set("x-request-id", requestId);
  headers.set("x-trace-id", traceId);

  // Stable correlation context attached to every breaker transition and proxy
  // log line: requestId, traceId, target URL.
  const ctx = `requestId=${requestId} traceId=${traceId} target=${targetUrl}`;
  const isLiveness = LIVENESS_PATHS.has(path);

  const startTime = performance.now();
  console.log(
    `[PROXY_ENTER] requestId=${requestId} traceId=${traceId} method=${method} path=${path} target=${targetUrl} liveness=${isLiveness}`
  );

  // Circuit Breaker check — liveness probes bypass it (see LIVENESS_PATHS) so
  // the health poll always reaches the backend and can drive recovery.
  if (!isLiveness && !breaker.check(ctx)) {
    const latency = Math.round(performance.now() - startTime);
    console.warn(
      `[PROXY_BREAKER] requestId=${requestId} method=${method} path=${path} target=${targetUrl} state=${breaker.getState()} reason=circuit_open`
    );
    return NextResponse.json(
      {
        ok: false,
        error: "CIRCUIT_OPEN",
        message: "The circuit breaker is open. The durable API backend server is unreachable. Please wait before retrying.",
        details: "Circuit breaker triggered due to consecutive connection failures.",
        runtimeId: "none",
        traceId,
        requestId,
        endpoint: path,
        statusCode: 503,
        latency,
      },
      {
        status: 503,
        headers: {
          "Retry-After": "8",
          "Cache-Control": "no-store",
        },
      }
    );
  }

  let body: BodyInit | null = null;
  if (method !== "GET" && method !== "HEAD") {
    try {
      body = await req.blob();
    } catch {
      body = null;
    }
  }

  let attempts = 0;
  const maxAttempts = 3;
  let delay = 150; // start with 150ms
  let lastError: any = null;
  let response: Response | null = null;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      response = await fetch(targetUrl, {
        method,
        headers,
        body,
        cache: "no-store",
      });
      break; // success — a response (even 5xx) means the backend is reachable
    } catch (err: any) {
      lastError = err;
      console.warn(
        `[PROXY_FETCH_FAILURE] requestId=${requestId} traceId=${traceId} attempt=${attempts}/${maxAttempts} method=${method} target=${targetUrl} reason=${err?.message ?? String(err)}`
      );
      const isRefused = err?.code === "ECONNREFUSED" ||
                        err?.message?.includes("ECONNREFUSED") ||
                        err?.message?.includes("fetch failed");
      if (isRefused && attempts < maxAttempts) {
        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        break; // terminal or max attempts
      }
    }
  }

  // Feed the breaker exactly ONCE per logical request — not once per retry
  // attempt. Counting each of the up-to-3 attempts as a separate failure made
  // failureThreshold=5 trip after fewer than two real requests, so the threshold
  // was effectively ~2, not 5. One logical failed request == one failure.
  if (response) {
    breaker.recordSuccess(ctx);
  } else {
    breaker.recordFailure(ctx);
  }

  const latency = Math.round(performance.now() - startTime);

  if (!response) {
    const errMessage = lastError instanceof Error ? lastError.message : String(lastError);
    const runtimeId = headers.get("x-runtime-id") || "none";
    console.warn(
      `[PROXY_FAILURE] requestId=${requestId} traceId=${traceId} method=${method} target=${targetUrl} attempts=${attempts} latency=${latency}ms error=${errMessage}`
    );

    return NextResponse.json(
      {
        ok: false,
        error: "ECONNREFUSED",
        message: "The durable API backend server is starting up or temporarily unreachable on port 4000. Please wait, the console will auto-reconnect shortly.",
        details: errMessage,
        runtimeId,
        traceId,
        requestId,
        endpoint: path,
        statusCode: 503,
        latency,
      },
      {
        status: 503,
        headers: {
          "Retry-After": "2",
          "Cache-Control": "no-store",
        },
      }
    );
  }

  const runtimeId = response.headers.get("x-runtime-id") || response.headers.get("runtime-id") || "none";
  const statusCode = response.status;

  // Log structured telemetry logs: requestId, traceId, target URL, response
  // status, latency, runtimeId.
  console.log(
    `[PROXY_REQUEST] requestId=${requestId} traceId=${traceId} method=${method} target=${targetUrl} status=${statusCode} latency=${latency}ms runtimeId=${runtimeId}`
  );

  // Strip hop-by-hop + encoding headers before re-emitting (the body is already
  // decoded — see STRIPPED_RESPONSE_HEADERS).
  const forwardHeaders = sanitizeHeaders(response.headers);

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    // SSE: stream the body straight through — never buffer a long-lived stream.
    return new NextResponse(response.body, {
      status: response.status,
      headers: forwardHeaders,
    });
  }

  // Read the (already-decoded) body. If the backend cuts the connection
  // mid-response — exactly what happens while it is crashing or draining —
  // blob() rejects. Catch it and return a clean, structured 502 rather than
  // letting the route handler throw, which Next surfaces as an opaque
  // "HTTP 500 Internal Server Error" that misdiagnoses an unreachable backend.
  let responseData: Blob;
  try {
    responseData = await response.blob();
  } catch (err: any) {
    breaker.recordFailure(ctx);
    const errMessage = err instanceof Error ? err.message : String(err);
    console.warn(
      `[PROXY_BODY_ERROR] requestId=${requestId} traceId=${traceId} method=${method} target=${targetUrl} status=${statusCode} reason=upstream_dropped_body latency=${latency}ms detail=${errMessage}`
    );
    return NextResponse.json(
      {
        ok: false,
        error: "UPSTREAM_READ_ERROR",
        message:
          "The durable API backend dropped the response mid-stream (it may be restarting). The console will auto-reconnect shortly.",
        details: errMessage,
        runtimeId,
        traceId,
        requestId,
        endpoint: path,
        statusCode: 502,
        latency,
      },
      {
        status: 502,
        headers: {
          "Retry-After": "2",
          "Cache-Control": "no-store",
        },
      }
    );
  }

  const responseBody = NULL_BODY_STATUSES.has(response.status) ? null : responseData;
  return new NextResponse(responseBody, {
    status: response.status,
    headers: forwardHeaders,
  });
}

export async function GET(req: NextRequest, context: RouteParams) {
  const params = await context.params;
  return handleProxy(req, params.path);
}

export async function POST(req: NextRequest, context: RouteParams) {
  const params = await context.params;
  return handleProxy(req, params.path);
}

export async function PATCH(req: NextRequest, context: RouteParams) {
  const params = await context.params;
  return handleProxy(req, params.path);
}

export async function DELETE(req: NextRequest, context: RouteParams) {
  const params = await context.params;
  return handleProxy(req, params.path);
}

export async function PUT(req: NextRequest, context: RouteParams) {
  const params = await context.params;
  return handleProxy(req, params.path);
}
