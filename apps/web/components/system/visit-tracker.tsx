"use client";

import { useEffect } from "react";

/**
 * Fires a single anonymous 'visit' funnel event on mount (top of the activation
 * funnel). Fully fire-and-forget — a failed ping never affects the page. The
 * backend endpoint is a no-op unless USER_AUTH_ENABLED.
 */
export function VisitTracker() {
  useEffect(() => {
    try {
      const key = "rl_visit_tracked";
      if (sessionStorage.getItem(key)) return; // one visit event per browser session
      sessionStorage.setItem(key, "1");
      void fetch("/api/runtime/auth/visit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: window.location.pathname,
          referrer: document.referrer || undefined
        }),
        keepalive: true
      }).catch(() => undefined);
    } catch {
      /* sessionStorage / fetch unavailable — ignore */
    }
  }, []);
  return null;
}
