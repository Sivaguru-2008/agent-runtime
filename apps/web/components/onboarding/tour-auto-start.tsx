"use client";

/**
 * Fires the first-run guided tour for a surface, once, if it hasn't been seen.
 *
 * Mounted inside each surface AFTER its chrome (tabs, toggle) is on screen, so
 * the tour's targets exist when it starts. A short delay lets layout settle so
 * the first coach-mark anchors correctly.
 */

import { useEffect } from "react";
import type { TourSurface } from "@/lib/onboarding/tour-steps";
import { useTour } from "./tour-provider";

export function TourAutoStart({ surface, delayMs = 350 }: { surface: TourSurface; delayMs?: number }) {
  const { maybeAutoStart } = useTour();
  useEffect(() => {
    const id = window.setTimeout(() => maybeAutoStart(surface), delayMs);
    return () => window.clearTimeout(id);
  }, [surface, delayMs, maybeAutoStart]);
  return null;
}
