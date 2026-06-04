"use client";

/**
 * Global "Explain Everything" mode + the explainability context.
 *
 * Two responsibilities:
 *   1. `enabled` — whether Explain Mode is on. When on, labels gain a visible
 *      "explain" affordance (dotted underline + info dot), graphs show their
 *      interpretation guide inline, and empty states expand. When off, all the
 *      same information is still ONE hover/click away — Explain Mode just makes
 *      it ambient instead of on-demand.
 *   2. `openConcept(id)` — opens the shared click-to-learn side panel for a
 *      concept from anywhere in the app.
 *
 * SSR/test-safe: the context has a working default, so components that use
 * `useExplainMode()` outside a provider (e.g. in renderToStaticMarkup tests)
 * render without throwing.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

const STORAGE_KEY = "runloop.explainMode";

interface ExplainModeContextValue {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  toggle: () => void;
  /** id of the concept currently shown in the side panel, if any. */
  activeConceptId?: string;
  openConcept: (id: string) => void;
  closeConcept: () => void;
}

const defaultValue: ExplainModeContextValue = {
  enabled: false,
  setEnabled: () => {},
  toggle: () => {},
  activeConceptId: undefined,
  openConcept: () => {},
  closeConcept: () => {},
};

const ExplainModeContext = createContext<ExplainModeContextValue>(defaultValue);

export function ExplainModeProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(false);
  const [activeConceptId, setActiveConceptId] = useState<string | undefined>();

  // Restore persisted preference on the client only.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === null) {
        // First-time visitor: default Explain Mode ON so newcomers get the
        // ambient explanations from the start. We deliberately do NOT persist
        // this — only an explicit toggle writes a value — so it stays on until
        // the user turns it off once, after which their choice is always kept.
        setEnabledState(true);
      } else {
        setEnabledState(stored === "1");
      }
    } catch {
      /* localStorage unavailable — leave the (off) default */
    }
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    try {
      window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch {
      /* ignore persistence failure */
    }
  }, []);

  const toggle = useCallback(() => setEnabled(!enabled), [enabled, setEnabled]);
  const openConcept = useCallback((id: string) => setActiveConceptId(id), []);
  const closeConcept = useCallback(() => setActiveConceptId(undefined), []);

  // Close the side panel on Escape for keyboard users.
  useEffect(() => {
    if (!activeConceptId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveConceptId(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeConceptId]);

  const value = useMemo(
    () => ({ enabled, setEnabled, toggle, activeConceptId, openConcept, closeConcept }),
    [enabled, setEnabled, toggle, activeConceptId, openConcept, closeConcept]
  );

  return <ExplainModeContext.Provider value={value}>{children}</ExplainModeContext.Provider>;
}

export function useExplainMode(): ExplainModeContextValue {
  return useContext(ExplainModeContext);
}
