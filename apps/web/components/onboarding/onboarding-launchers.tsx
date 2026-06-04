"use client";

/**
 * Top-bar launchers for the discovery layer:
 *   - "Take the tour" — replays the current surface's guided tour.
 *   - Glossary button — opens the ⌘K concept search.
 *
 * Both sit beside the "Explain Everything" toggle. The glossary button carries a
 * `data-tour` attribute so the tour itself can point at it.
 */

import { GraduationCap, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TourSurface } from "@/lib/onboarding/tour-steps";
import { useTour } from "./tour-provider";
import { useGlossary } from "./concept-glossary";

const GLOSSARY_TOUR_ID: Record<TourSurface, string> = {
  dashboard: "glossary-button",
  operator: "op-glossary-button",
};

export function TakeTheTourButton({ surface, className }: { surface: TourSurface; className?: string }) {
  const { start } = useTour();
  return (
    <button
      type="button"
      onClick={() => start(surface)}
      title="Replay the guided tour of this surface"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400",
        className
      )}
    >
      <GraduationCap className="h-3.5 w-3.5" />
      Take the tour
    </button>
  );
}

export function GlossaryButton({ surface, className }: { surface: TourSurface; className?: string }) {
  const { open } = useGlossary();
  return (
    <button
      type="button"
      data-tour={GLOSSARY_TOUR_ID[surface]}
      onClick={open}
      title="Search every concept on the platform (⌘K)"
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400",
        className
      )}
    >
      <Search className="h-3.5 w-3.5" />
      Search
      <kbd className="ml-0.5 hidden rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-[9px] font-semibold text-zinc-500 sm:inline">
        ⌘K
      </kbd>
    </button>
  );
}

/** Both launchers, in the order they appear next to the Explain toggle. */
export function OnboardingLaunchers({ surface, className }: { surface: TourSurface; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <GlossaryButton surface={surface} />
      <TakeTheTourButton surface={surface} />
    </div>
  );
}
