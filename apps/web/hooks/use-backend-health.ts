"use client";

/**
 * useBackendHealth — live backend connectivity state for the console.
 *
 * Polls the durable API's /health endpoint (through the Next proxy at
 * /api/runtime → http://localhost:4000) and exposes a connectivity snapshot so
 * the UI can show an explicit "Backend offline" banner instead of letting every
 * panel fail with an opaque fetch error. Tracks the host/port, the last
 * successful health check, and the last failure reason — exactly the context an
 * operator needs to know whether to restart the API.
 *
 * Cadence: 5s when healthy, 2s when offline so recovery is detected quickly.
 *
 * Flap resistance: a single missed or slow probe must NOT flip the banner to
 * "offline". In local dev the API runs under `tsx watch`, which frees port 4000
 * for ~1-3s on every source edit, and a GC pause under load can blow past the
 * 4s probe timeout — both are transient and self-heal on the very next probe.
 * The hook therefore debounces: it declares "offline" only after
 * OFFLINE_AFTER_FAILURES consecutive failed probes, and snaps straight back to
 * "online" on the first success. This keeps a genuine outage visible within a
 * couple of seconds while eliminating the false-positive flapping.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type BackendStatus = "checking" | "online" | "offline";

export interface BackendHealth {
  status: BackendStatus;
  /** Display host of the durable API the console talks to. */
  host: string;
  /** Display port of the durable API. */
  port: number;
  /** ISO timestamp of the last successful /health response, or null. */
  lastSuccessAt: string | null;
  /** Human-readable reason for the most recent failure, or null. */
  lastFailureReason: string | null;
  /** x-runtime-id from the last successful response (correlates server logs). */
  runtimeId: string | null;
  /** Round-trip latency of the last successful probe, in ms. */
  latencyMs: number | null;
}

const HEALTH_PATH = `${process.env.NEXT_PUBLIC_API_URL ?? "/api/runtime"}/health`;
const API_HOST = process.env.NEXT_PUBLIC_API_HOST ?? "localhost";
const API_PORT = Number(process.env.NEXT_PUBLIC_API_PORT ?? 4000);
const POLL_OK_MS = 5_000;
const POLL_DOWN_MS = 2_000;
const PROBE_TIMEOUT_MS = 4_000;
// Consecutive failed probes required before the banner declares "offline".
// 2 × POLL_DOWN_MS ≈ a ~2s grace that rides through a tsx-watch reload window
// or a GC pause, without hiding a real outage for long.
const OFFLINE_AFTER_FAILURES = 2;

export function useBackendHealth(): BackendHealth {
  const [health, setHealth] = useState<BackendHealth>({
    status: "checking",
    host: API_HOST,
    port: API_PORT,
    lastSuccessAt: null,
    lastFailureReason: null,
    runtimeId: null,
    latencyMs: null
  });

  // Keep the last success across failed probes without retriggering effects.
  const lastSuccessRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  // Consecutive-failure counter for the offline debounce (see OFFLINE_AFTER_FAILURES).
  const failuresRef = useRef(0);

  const probe = useCallback(async () => {
    // Debounced failure: count consecutive misses and only flip to "offline"
    // once OFFLINE_AFTER_FAILURES is reached. Until then keep the prior status
    // (so a single blip never shows the banner) while still recording the reason.
    const registerFailure = (reason: string) => {
      failuresRef.current += 1;
      if (cancelledRef.current) return;
      const goOffline = failuresRef.current >= OFFLINE_AFTER_FAILURES;
      setHealth((prev) => ({
        ...prev,
        status: goOffline ? "offline" : prev.status,
        lastSuccessAt: lastSuccessRef.current,
        lastFailureReason: reason,
        ...(goOffline ? { latencyMs: null } : {})
      }));
    };

    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(HEALTH_PATH, {
        cache: "no-store",
        signal: controller.signal,
        headers: { accept: "application/json" }
      });
      const latencyMs = Math.round(performance.now() - started);
      let body: { ok?: boolean; message?: string; error?: string } | null = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      // The proxy answers 503 with { ok:false, error:"ECONNREFUSED" } when the
      // backend is down — treat that as offline, not as a reachable backend.
      const healthy = res.ok && body?.ok !== false;
      if (healthy) {
        const now = new Date().toISOString();
        lastSuccessRef.current = now;
        failuresRef.current = 0; // recovery: reset the debounce immediately
        if (!cancelledRef.current) {
          setHealth((prev) => ({
            ...prev,
            status: "online",
            lastSuccessAt: now,
            lastFailureReason: null,
            runtimeId: res.headers.get("x-runtime-id") ?? prev.runtimeId,
            latencyMs
          }));
        }
        return true;
      }

      const reason =
        body?.message ?? body?.error ?? `HTTP ${res.status} ${res.statusText || ""}`.trim();
      registerFailure(reason);
      return false;
    } catch (err) {
      const reason =
        err instanceof DOMException && err.name === "AbortError"
          ? `No response within ${PROBE_TIMEOUT_MS}ms (backend not answering on port ${API_PORT})`
          : err instanceof Error
            ? err.message
            : String(err);
      registerFailure(reason);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;

    const tick = async () => {
      const ok = await probe();
      if (cancelledRef.current) return;
      timerRef.current = setTimeout(tick, ok ? POLL_OK_MS : POLL_DOWN_MS);
    };
    void tick();

    // Re-probe immediately when the tab regains focus / the network returns.
    const onFocus = () => void probe();
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
    };
  }, [probe]);

  return health;
}
