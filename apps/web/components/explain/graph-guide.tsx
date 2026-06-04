"use client";

/**
 * Visual improvements for every graph.
 *
 * A compact strip placed under (or beside) any chart that answers:
 *   - What you are looking at
 *   - What good looks like
 *   - What bad looks like
 *   - Current interpretation (from the live value)
 *   - Recommended action
 *
 * Pass a `value` to get a live reading via the concept's `interpret()`. When
 * Explain Mode is ON the guide is always expanded; when OFF it collapses to a
 * single "What am I looking at?" affordance the user can expand on demand.
 */

import { useState } from "react";
import { ChevronDown, Eye, Lightbulb } from "lucide-react";
import { getConcept } from "@/lib/explain/registry";
import type { Health } from "@/lib/explain/types";
import { cn } from "@/lib/utils";
import { useExplainMode } from "./explain-mode";

const LEVEL_STYLES: Record<Health, { dot: string; text: string; ring: string }> = {
  healthy: { dot: "bg-emerald-400", text: "text-emerald-300", ring: "border-emerald-500/40 bg-emerald-500/5" },
  warning: { dot: "bg-amber-400", text: "text-amber-300", ring: "border-amber-500/40 bg-amber-500/5" },
  critical: { dot: "bg-rose-400", text: "text-rose-300", ring: "border-rose-500/40 bg-rose-500/5" },
  neutral: { dot: "bg-zinc-400", text: "text-zinc-300", ring: "border-zinc-700 bg-zinc-500/5" },
};

export function GraphGuide({
  concept: conceptId,
  value,
  className,
}: {
  concept: string;
  /** Current numeric value, if the metric has a live interpretation. */
  value?: number;
  className?: string;
}) {
  const { enabled, openConcept } = useExplainMode();
  const [open, setOpen] = useState(false);
  const concept = getConcept(conceptId);
  if (!concept) return null;

  const expanded = enabled || open;
  const interp =
    typeof value === "number" && concept.interpret ? concept.interpret(value) : undefined;
  const level = interp?.level ?? "neutral";
  const styles = LEVEL_STYLES[level];

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900/60 px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200",
          className
        )}
      >
        <Eye className="h-3 w-3" />
        What am I looking at?
        <ChevronDown className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div className={cn("rounded-lg border p-3 text-xs", styles.ring, className)}>
      <div className="flex items-start gap-2">
        <Lightbulb className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", styles.text)} />
        <div className="min-w-0 space-y-2">
          {/* What you're looking at */}
          <p className="text-zinc-300">
            <span className="font-medium text-zinc-200">What this shows: </span>
            {concept.short}{" "}
            <button
              type="button"
              onClick={() => openConcept(conceptId)}
              className="text-sky-400 underline decoration-dotted underline-offset-2 hover:decoration-solid"
            >
              learn more
            </button>
          </p>

          {/* Good / bad */}
          {(concept.good || concept.bad) && (
            <div className="grid gap-1 sm:grid-cols-2">
              {concept.good ? (
                <div className="flex items-start gap-1.5">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
                  <span className="text-zinc-400">
                    <span className="font-medium text-emerald-300/90">Good: </span>
                    {concept.good}
                  </span>
                </div>
              ) : null}
              {concept.bad ? (
                <div className="flex items-start gap-1.5">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" aria-hidden />
                  <span className="text-zinc-400">
                    <span className="font-medium text-rose-300/90">Bad: </span>
                    {concept.bad}
                  </span>
                </div>
              ) : null}
            </div>
          )}

          {/* Live interpretation */}
          {interp ? (
            <div className="rounded-md border border-zinc-800 bg-zinc-950/50 p-2 space-y-1">
              <div className="flex items-center gap-1.5">
                <span className={cn("h-2 w-2 rounded-full", styles.dot)} aria-hidden />
                <span className={cn("font-medium", styles.text)}>{interp.reading}</span>
              </div>
              {interp.impact ? (
                <p className="text-zinc-400">
                  <span className="font-medium text-zinc-300">Impact: </span>
                  {interp.impact}
                </p>
              ) : null}
              {interp.recommendation ? (
                <p className="text-zinc-400">
                  <span className="font-medium text-zinc-300">Recommended: </span>
                  {interp.recommendation}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
