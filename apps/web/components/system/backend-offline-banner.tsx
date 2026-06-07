"use client";

/**
 * BackendOfflineBanner — explicit, always-visible backend connectivity state.
 *
 * When the durable API on port 4000 is unreachable, every data panel would
 * otherwise fail with its own opaque error. This banner gives the operator one
 * clear, authoritative signal: "Backend offline", with the host, port, the last
 * successful health check, and the last failure reason — the exact context
 * needed to decide whether to (re)start the API (`npm run dev` or
 * `npm run start:supervised`).
 *
 * It renders nothing while the backend is healthy, and a slim confirmation strip
 * for a few seconds after recovery so a flapping backend is visible.
 */

import { useEffect, useState } from "react";
import { useBackendHealth } from "@/hooks/use-backend-health";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

export function BackendOfflineBanner() {
  const health = useBackendHealth();
  const [recovered, setRecovered] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    if (health.status === "offline") {
      setWasOffline(true);
      setRecovered(false);
    } else if (health.status === "online" && wasOffline) {
      setRecovered(true);
      setWasOffline(false);
      const t = setTimeout(() => setRecovered(false), 4_000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [health.status, wasOffline]);

  if (health.status === "online") {
    if (!recovered) return null;
    return (
      <div
        role="status"
        className="fixed bottom-4 right-4 z-[1000] flex items-center gap-2 rounded-lg bg-emerald-600/95 px-3 py-2 text-sm font-medium text-white shadow-lg ring-1 ring-emerald-300/30"
      >
        <span className="inline-block h-2 w-2 rounded-full bg-white" />
        Backend reconnected on {health.host}:{health.port}
      </div>
    );
  }

  // checking (first paint) — stay quiet to avoid a flash on initial load.
  if (health.status === "checking") return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed inset-x-0 bottom-0 z-[1000] border-t border-red-400/40 bg-red-700/95 px-4 py-2 text-white shadow-xl backdrop-blur"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
          </span>
          <span className="text-sm font-semibold tracking-wide">Backend offline</span>
          <code className="rounded bg-black/30 px-1.5 py-0.5 text-xs">
            {health.host}:{health.port}
          </code>
        </div>
        <div className="flex flex-col text-xs text-red-50 sm:flex-row sm:items-center sm:gap-4">
          <span>
            Last healthy check:{" "}
            <span className="font-medium text-white">{timeAgo(health.lastSuccessAt)}</span>
          </span>
          {health.lastFailureReason ? (
            <span className="truncate" title={health.lastFailureReason}>
              Reason: <span className="font-medium text-white">{health.lastFailureReason}</span>
            </span>
          ) : null}
          <span className="text-red-100/80">
            Start it with <code className="rounded bg-black/30 px-1 py-0.5">npm run dev</code> — retrying…
          </span>
        </div>
      </div>
    </div>
  );
}
