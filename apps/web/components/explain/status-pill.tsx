"use client";

/**
 * Layer 2 — Status translation, as a drop-in pill.
 *
 *   <StatusPill status="LOST" />        → "Connection Lost" (red) + hover meaning
 *   <StatusPill status="MEMORY_COMMIT"/>→ "Saving Learned Information"
 *
 * Hovering shows the plain-language meaning and the original machine code, so
 * first-time users understand it and experienced operators still see the raw
 * value. Use `raw` to append the code inline.
 */

import { translateStatus, TONE_CLASSES, TONE_DOT } from "@/lib/explain/status";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

export function StatusPill({
  status,
  className,
  raw = false,
  dot = true,
}: {
  status?: string | null;
  className?: string;
  /** Append the original code in monospace, e.g. "Connection Lost · LOST". */
  raw?: boolean;
  /** Show the leading tone dot. */
  dot?: boolean;
}) {
  const t = translateStatus(status);
  return (
    <Tooltip
      content={
        <div className="space-y-1">
          <div className="font-semibold text-zinc-100">{t.label}</div>
          <p className="text-zinc-300">{t.meaning}</p>
          {t.code ? (
            <p className="pt-0.5 text-[10px] uppercase tracking-wide text-zinc-500">System code: {t.code}</p>
          ) : null}
        </div>
      }
    >
      <span
        className={cn(
          "inline-flex cursor-help items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium",
          TONE_CLASSES[t.tone],
          className
        )}
      >
        {dot ? <span className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[t.tone])} aria-hidden /> : null}
        {t.label}
        {raw && t.code ? <span className="font-mono text-[10px] opacity-60">{t.code}</span> : null}
      </span>
    </Tooltip>
  );
}
