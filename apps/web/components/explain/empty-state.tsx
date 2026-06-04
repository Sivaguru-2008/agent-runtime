"use client";

/**
 * Empty-state redesign.
 *
 * Replaces bare "No data" strings with explanatory copy:
 *   "No memory influence recorded"
 *      → "No memory was used during this execution. The agents completed the
 *         task without referencing stored knowledge."
 *
 * Pulls `emptyTitle` / `emptyBody` from the concept registry so the words live
 * in one place. Falls back to provided `title`/`body` props for one-offs.
 */

import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { getConcept } from "@/lib/explain/registry";
import { cn } from "@/lib/utils";
import { useExplainMode } from "./explain-mode";

export function ExplainedEmptyState({
  concept: conceptId,
  title,
  body,
  icon,
  className,
}: {
  /** Concept whose emptyTitle/emptyBody to use. */
  concept?: string;
  /** Override title (used when no concept, or to customise). */
  title?: string;
  /** Override body. */
  body?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const { openConcept } = useExplainMode();
  const concept = conceptId ? getConcept(conceptId) : undefined;

  const resolvedTitle = title ?? concept?.emptyTitle ?? "Nothing to show yet";
  const resolvedBody = body ?? concept?.emptyBody ?? "There's no data for this view right now.";

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-700/70 bg-zinc-900/30 px-6 py-8 text-center",
        className
      )}
    >
      <div className="text-zinc-500">{icon ?? <Info className="h-5 w-5" />}</div>
      <div className="text-sm font-medium text-zinc-200">{resolvedTitle}</div>
      <p className="max-w-md text-xs leading-relaxed text-zinc-400">{resolvedBody}</p>
      {concept ? (
        <button
          type="button"
          onClick={() => openConcept(concept.id)}
          className="mt-1 text-[11px] font-medium text-sky-400 underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >
          What is {concept.label}?
        </button>
      ) : null}
    </div>
  );
}
