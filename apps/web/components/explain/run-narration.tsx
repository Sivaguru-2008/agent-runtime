"use client";

/**
 * Layer 4 — Live narration.
 *
 * Renders the run as a plain-language story instead of raw machine states:
 *
 *   ① Task Received      The system accepted your request.
 *   ↓
 *   ② Task Planned       The planner created an execution strategy.
 *   ↓  … and so on through Verified, Reviewed, Memory Updated, Completed.
 *
 * Pass whatever signals you have (event types and/or cognition node roles) plus
 * the terminal outcome; the narration engine decides which beats happened.
 */

import { Check, Loader2, Circle, X, MinusCircle } from "lucide-react";
import { narrateRun, narrationProgress, type NarrationStatus, type NarrateInput } from "@/lib/explain/narration";
import { cn } from "@/lib/utils";

const STATUS_META: Record<
  NarrationStatus,
  { icon: typeof Check; ring: string; text: string; line: string }
> = {
  done: { icon: Check, ring: "border-emerald-500/60 bg-emerald-500/15 text-emerald-300", text: "text-zinc-200", line: "bg-emerald-500/40" },
  active: { icon: Loader2, ring: "border-sky-400/70 bg-sky-500/15 text-sky-300", text: "text-zinc-100", line: "bg-zinc-700" },
  pending: { icon: Circle, ring: "border-zinc-700 bg-zinc-900 text-zinc-600", text: "text-zinc-500", line: "bg-zinc-800" },
  skipped: { icon: MinusCircle, ring: "border-zinc-700 bg-zinc-900 text-zinc-600", text: "text-zinc-500", line: "bg-zinc-800" },
  failed: { icon: X, ring: "border-rose-500/60 bg-rose-500/15 text-rose-300", text: "text-rose-200", line: "bg-rose-500/40" },
};

export function RunNarration({
  signals,
  outcome = "unknown",
  className,
  title = "What's happening, in plain language",
}: NarrateInput & { className?: string; title?: string }) {
  const steps = narrateRun({ signals, outcome });
  const { done, total } = narrationProgress(steps);

  return (
    <div className={cn("rounded-lg border border-zinc-800 bg-zinc-950/40 p-4", className)}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
        <span className="text-[11px] text-zinc-500">
          {done} of {total} steps
        </span>
      </div>
      <ol className="space-y-0">
        {steps.map((step, i) => {
          const meta = STATUS_META[step.status];
          const Icon = meta.icon;
          const isLast = i === steps.length - 1;
          return (
            <li key={step.key} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                    meta.ring
                  )}
                  aria-hidden
                >
                  <Icon className={cn("h-3.5 w-3.5", step.status === "active" && "animate-spin")} />
                </span>
                {!isLast ? <span className={cn("my-0.5 w-px flex-1", meta.line)} aria-hidden /> : null}
              </div>
              <div className={cn("pb-4", isLast && "pb-0")}>
                <div className={cn("text-sm font-medium", meta.text)}>
                  <span className="mr-1.5 text-zinc-500">Step {i + 1}</span>
                  {step.title}
                  {step.status === "skipped" ? <span className="ml-1.5 text-[10px] text-zinc-600">(not needed)</span> : null}
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{step.description}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
