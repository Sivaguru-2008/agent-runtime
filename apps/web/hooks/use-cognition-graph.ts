"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cognitionApi,
  type CognitionGraphView,
  type FailureReport,
  type MemoryInfluenceHeatmap
} from "@/lib/cognition-api";

export interface UseCognitionGraphResult {
  view: CognitionGraphView | undefined;
  failureReport: FailureReport | undefined;
  influence: MemoryInfluenceHeatmap | undefined;
  isLoading: boolean;
  error: string | undefined;
  refresh: () => Promise<void>;
}

/**
 * Loads a cognition graph + failure report + memory influence map and keeps
 * them in lockstep with the supplied `cognitionId`.
 *
 * Stale-response defence: a generation token (bumped every time
 * `cognitionId` changes) is captured at the start of every fetch. When the
 * promise resolves, the result is dropped if the token has been superseded
 * — eliminates the race where a slow response for cognition A overwrites
 * the freshly-loaded view for cognition B.
 */
export function useCognitionGraph(cognitionId: string | undefined): UseCognitionGraphResult {
  const [view, setView] = useState<CognitionGraphView | undefined>();
  const [failureReport, setFailureReport] = useState<FailureReport | undefined>();
  const [influence, setInfluence] = useState<MemoryInfluenceHeatmap | undefined>();
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(cognitionId));
  const [error, setError] = useState<string | undefined>();

  // Monotonic generation token. Bumped on every cognitionId change so any
  // in-flight refresh closing over the prior token discards its result.
  const generationRef = useRef(0);
  const requestedIdRef = useRef<string | undefined>(cognitionId);

  const refresh = useCallback(async () => {
    if (!cognitionId) {
      // Clear stale state when the caller deselects.
      setView(undefined);
      setFailureReport(undefined);
      setInfluence(undefined);
      setIsLoading(false);
      setError(undefined);
      return;
    }

    const myGeneration = ++generationRef.current;
    requestedIdRef.current = cognitionId;
    setIsLoading(true);

    try {
      const [g, f, i] = await Promise.all([
        cognitionApi.get(cognitionId),
        cognitionApi.failureReport(cognitionId).catch(() => undefined),
        cognitionApi.memoryInfluence(cognitionId).catch(() => undefined)
      ]);

      // Discard if a newer refresh has started — prevents cognitionA's
      // delayed response from overwriting cognitionB's view.
      if (myGeneration !== generationRef.current) return;
      if (requestedIdRef.current !== cognitionId) return;
      // Sanity: server returned a graph for a different id.
      if (g && g.graph && g.graph.id && g.graph.id !== cognitionId) return;

      setView(g);
      setFailureReport(f);
      setInfluence(i);
      setError(undefined);
    } catch (err) {
      if (myGeneration !== generationRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (myGeneration === generationRef.current) {
        setIsLoading(false);
      }
    }
  }, [cognitionId]);

  useEffect(() => {
    // Clear previous render's data immediately so the UI cannot display
    // cognitionA's graph while cognitionB is loading. Critical for the
    // "old cognition graph persists" symptom.
    if (cognitionId !== requestedIdRef.current) {
      setView(undefined);
      setFailureReport(undefined);
      setInfluence(undefined);
    }
    void refresh();
  }, [refresh, cognitionId]);

  return { view, failureReport, influence, isLoading, error, refresh };
}
