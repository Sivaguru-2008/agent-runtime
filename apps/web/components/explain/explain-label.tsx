"use client";

/**
 * Layer 1 (micro explanation, on hover) + Layer 3 entry (click to learn).
 *
 * Wrap any label, metric name, or column header:
 *   <ExplainLabel concept="memory-drift">Memory Drift</ExplainLabel>
 *
 * Hovering shows the micro explanation (what / why it matters / healthy range /
 * example). Clicking opens the full click-to-learn side panel. When Explain
 * Mode is on, a visible dotted underline + info dot advertise that the label is
 * explainable; when off, the same affordance is available but quieter.
 */

import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { getConcept } from "@/lib/explain/registry";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { useExplainMode } from "./explain-mode";

export function MicroExplanation({ conceptId }: { conceptId: string }) {
  const concept = getConcept(conceptId);
  if (!concept) return null;
  return (
    <div className="space-y-1.5">
      <div className="font-semibold text-zinc-100">{concept.label}</div>
      <p className="text-zinc-300">{concept.short}</p>
      <p className="text-zinc-400">
        <span className="font-medium text-zinc-300">Why it matters: </span>
        {concept.whyCare}
      </p>
      {concept.healthy ? (
        <p className="text-emerald-300/90">
          <span className="font-medium">Healthy: </span>
          {concept.healthy}
        </p>
      ) : null}
      {concept.example ? (
        <p className="text-zinc-400">
          <span className="font-medium text-zinc-300">Example: </span>
          {concept.example}
        </p>
      ) : null}
      <p className="pt-0.5 text-[10px] uppercase tracking-wide text-zinc-500">Click for the full explanation →</p>
    </div>
  );
}

export function ExplainLabel({
  concept: conceptId,
  children,
  className,
  iconClassName,
  side = "top",
  as = "span",
}: {
  concept: string;
  children: ReactNode;
  className?: string;
  iconClassName?: string;
  side?: "top" | "right" | "bottom" | "left";
  /** Element used to render the label text (keeps headings semantic). */
  as?: "span" | "div";
}) {
  const { enabled, openConcept } = useExplainMode();
  const concept = getConcept(conceptId);

  // Unknown concept → render children untouched so nothing breaks.
  if (!concept) return <>{children}</>;

  const Label = as;

  return (
    <Tooltip side={side} content={<MicroExplanation conceptId={conceptId} />}>
      <button
        type="button"
        onClick={() => openConcept(conceptId)}
        aria-label={`Explain: ${concept.label}`}
        className={cn(
          "group inline-flex max-w-full items-center gap-1 text-left align-baseline",
          "cursor-help underline-offset-4 decoration-dotted hover:decoration-solid focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/70 rounded-sm",
          enabled ? "decoration-sky-400/60 underline" : "decoration-zinc-500/40 hover:underline",
          className
        )}
      >
        <Label className="truncate">{children}</Label>
        <Info
          className={cn(
            "h-3 w-3 shrink-0 transition-opacity",
            enabled ? "text-sky-400/80 opacity-100" : "text-zinc-500 opacity-0 group-hover:opacity-100",
            iconClassName
          )}
          aria-hidden
        />
      </button>
    </Tooltip>
  );
}
