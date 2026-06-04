"use client";

/**
 * The global "Explain Everything" switch. Lives in the top bar of every
 * surface. When on, every metric gains a description, every graph an
 * interpretation, every status a translation, every empty state an
 * explanation — the platform reads like an expert sitting beside you.
 */

import { GraduationCap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useExplainMode } from "./explain-mode";

export function ExplainModeToggle({ className }: { className?: string }) {
  const { enabled, toggle } = useExplainMode();
  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={enabled}
      aria-label="Explain Everything mode"
      title={
        enabled
          ? "Explain Everything is ON — descriptions, interpretations and translations are shown inline. Click to turn off."
          : "Turn on Explain Everything — show descriptions, graph interpretations and plain-language translations everywhere."
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400",
        enabled
          ? "border-sky-500/60 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25"
          : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200",
        className
      )}
    >
      <GraduationCap className="h-3.5 w-3.5" />
      Explain Everything
      <span
        aria-hidden
        className={cn(
          "ml-0.5 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
          enabled ? "bg-sky-400/20 text-sky-100" : "bg-zinc-800 text-zinc-500"
        )}
      >
        {enabled ? "On" : "Off"}
      </span>
    </button>
  );
}
