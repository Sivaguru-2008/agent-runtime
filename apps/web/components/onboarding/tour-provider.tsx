"use client";

/**
 * Guided-tour state machine + context.
 *
 * Owns which surface's tour is running, the current step, and the per-surface
 * "seen" flags persisted to localStorage. The visible coach-marks live in
 * `TourOverlay`, which reads this context; surfaces call `start(surface)` to
 * replay the tour and `maybeAutoStart(surface)` for first-run.
 *
 * SSR/test-safe: a working default context lets components render outside a
 * provider without throwing. `prefers-reduced-motion` is detected here and
 * exposed so the overlay can skip its transitions.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getTour, tourSeenKey, type TourStep, type TourSurface } from "@/lib/onboarding/tour-steps";

interface TourContextValue {
  surface: TourSurface | null;
  running: boolean;
  stepIndex: number;
  steps: TourStep[];
  currentStep: TourStep | null;
  total: number;
  reducedMotion: boolean;
  /** Start (or replay) a surface's tour. `force` is implied — replays always run. */
  start: (surface: TourSurface) => void;
  /** Start only if this surface's tour has not been seen yet (first-run). */
  maybeAutoStart: (surface: TourSurface) => void;
  next: () => void;
  back: () => void;
  /** Dismiss without finishing — still marks the tour seen. */
  skip: () => void;
  /** Reached the end — marks the tour seen. */
  finish: () => void;
  isSeen: (surface: TourSurface) => boolean;
}

const noop = () => {};
const defaultValue: TourContextValue = {
  surface: null,
  running: false,
  stepIndex: 0,
  steps: [],
  currentStep: null,
  total: 0,
  reducedMotion: false,
  start: noop,
  maybeAutoStart: noop,
  next: noop,
  back: noop,
  skip: noop,
  finish: noop,
  isSeen: () => false,
};

const TourContext = createContext<TourContextValue>(defaultValue);

function readSeen(surface: TourSurface): boolean {
  try {
    return window.localStorage.getItem(tourSeenKey(surface)) === "1";
  } catch {
    return false;
  }
}

function writeSeen(surface: TourSurface): void {
  try {
    window.localStorage.setItem(tourSeenKey(surface), "1");
  } catch {
    /* ignore persistence failure */
  }
}

export function TourProvider({ children }: { children: ReactNode }) {
  const [surface, setSurface] = useState<TourSurface | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  // Guards maybeAutoStart so it fires at most once per surface per page load.
  const autoStarted = useRef<Set<TourSurface>>(new Set());

  // Detect prefers-reduced-motion (guarded for jsdom / older browsers).
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReducedMotion(mq.matches);
    apply();
    // addEventListener is the modern API; fall back to addListener for old Safari.
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
    mq.addListener?.(apply);
    return () => mq.removeListener?.(apply);
  }, []);

  const steps = useMemo<TourStep[]>(() => (surface ? getTour(surface).steps : []), [surface]);
  const running = surface !== null;
  const total = steps.length;
  const currentStep = running && stepIndex < total ? steps[stepIndex] : null;

  const start = useCallback((next: TourSurface) => {
    setSurface(next);
    setStepIndex(0);
  }, []);

  const maybeAutoStart = useCallback((next: TourSurface) => {
    if (autoStarted.current.has(next)) return;
    autoStarted.current.add(next);
    if (readSeen(next)) return;
    setSurface(next);
    setStepIndex(0);
  }, []);

  const stop = useCallback(() => {
    setSurface((s) => {
      if (s) writeSeen(s);
      return null;
    });
    setStepIndex(0);
  }, []);

  const next = useCallback(() => {
    setStepIndex((i) => {
      if (i + 1 >= total) {
        // Past the last step → finish.
        stop();
        return 0;
      }
      return i + 1;
    });
  }, [total, stop]);

  const back = useCallback(() => setStepIndex((i) => Math.max(0, i - 1)), []);
  const skip = useCallback(() => stop(), [stop]);
  const finish = useCallback(() => stop(), [stop]);
  const isSeen = useCallback((s: TourSurface) => readSeen(s), []);

  const value = useMemo<TourContextValue>(
    () => ({
      surface,
      running,
      stepIndex,
      steps,
      currentStep,
      total,
      reducedMotion,
      start,
      maybeAutoStart,
      next,
      back,
      skip,
      finish,
      isSeen,
    }),
    [surface, running, stepIndex, steps, currentStep, total, reducedMotion, start, maybeAutoStart, next, back, skip, finish, isSeen]
  );

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour(): TourContextValue {
  return useContext(TourContext);
}
