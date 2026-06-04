"use client";

/**
 * Layer 5 — Why panel.
 *
 * Every action should answer "Why did this happen?". Drop a WhyChip next to any
 * state or event:
 *
 *   <WhyChip concept="dlq" />                       // all "why" Q&A for a concept
 *   <WhyChip question="Why was this retried?"        // a single explained reason
 *           answer="Its failure was recoverable…" />
 *
 * Renders a small "Why?" button that expands an inline, accessible answer card.
 */

import { useState } from "react";
import { HelpCircle, ChevronDown } from "lucide-react";
import { getConcept } from "@/lib/explain/registry";
import type { FaqItem } from "@/lib/explain/types";
import { cn } from "@/lib/utils";

export function WhyChip({
  concept: conceptId,
  question,
  answer,
  label = "Why?",
  className,
}: {
  concept?: string;
  question?: string;
  answer?: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const items: FaqItem[] = (() => {
    if (question && answer) return [{ q: question, a: answer }];
    const concept = conceptId ? getConcept(conceptId) : undefined;
    return concept?.whyQuestions ?? [];
  })();

  if (items.length === 0) return null;

  return (
    <div className={cn("inline-block", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400",
          open
            ? "border-sky-500/50 bg-sky-500/10 text-sky-200"
            : "border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
        )}
      >
        <HelpCircle className="h-3 w-3" />
        {label}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="mt-1.5 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/80 p-3 text-xs shadow-lg">
          {items.map((item) => (
            <div key={item.q} className="space-y-0.5">
              <div className="font-medium text-zinc-200">{item.q}</div>
              <p className="leading-relaxed text-zinc-400">{item.a}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
