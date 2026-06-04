"use client";

/**
 * The visible guided tour — a spotlight + coach-mark anchored to each step's
 * target element.
 *
 * Reads choreography from `TourProvider` and copy from the concept registry
 * (the step's `concept`). Behaviour:
 *   - Spotlights the target by dimming everything around it (four panels) and
 *     drawing a ring around it; falls back to a centred card if the target is
 *     missing so the tour never goes blank.
 *   - Keyboard-navigable: → / Enter advances, ← goes back, Esc skips. The
 *     primary button is focused on each step so Enter "just works".
 *   - Respects prefers-reduced-motion: transitions are dropped when the user
 *     asked for reduced motion.
 *   - "Learn more" opens the full click-to-learn panel for the step's concept.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, GraduationCap, X } from "lucide-react";
import { getConcept } from "@/lib/explain/registry";
import { cn } from "@/lib/utils";
import { useExplainMode } from "@/components/explain/explain-mode";
import { useTour } from "./tour-provider";

const POPOVER_WIDTH = 340;
const GAP = 12;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function findTarget(target: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
}

function safeScrollIntoView(el: HTMLElement): void {
  if (typeof el.scrollIntoView !== "function") return;
  try {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    /* jsdom / unsupported — ignore */
  }
}

export function TourOverlay() {
  const { running, currentStep, stepIndex, total, reducedMotion, next, back, skip } = useTour();
  const { openConcept } = useExplainMode();
  const [rect, setRect] = useState<Rect | null>(null);
  const primaryBtnRef = useRef<HTMLButtonElement>(null);

  const target = currentStep?.target;
  const activate = currentStep?.activate ?? false;

  // Activate (click) the target on entering a step so the described surface is
  // visible, then measure where it landed.
  const measure = useCallback(() => {
    if (!target) {
      setRect(null);
      return;
    }
    const el = findTarget(target);
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [target]);

  useLayoutEffect(() => {
    if (!running || !target) return;
    const el = findTarget(target);
    if (el) {
      if (activate) el.click();
      safeScrollIntoView(el);
    }
    measure();
    // Re-measure on the next frame in case activation reflowed the page.
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(measure) : null;
    return () => {
      if (raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    };
    // stepIndex drives re-activation per step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, stepIndex, target, activate, measure]);

  // Keep the spotlight glued to the target on scroll / resize.
  useEffect(() => {
    if (!running) return;
    const onMove = () => measure();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [running, measure]);

  // Focus the primary action so keyboard users land on it each step.
  useEffect(() => {
    if (!running) return;
    primaryBtnRef.current?.focus();
  }, [running, stepIndex]);

  // Keyboard navigation. Arrows + Escape on the window; Enter is handled by the
  // focused primary button natively (so it never double-fires).
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      } else if (e.key === "Escape") {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, next, back, skip]);

  if (!running || !currentStep) return null;

  const concept = getConcept(currentStep.concept);
  const title = concept?.label ?? currentStep.concept;
  const body = concept?.short ?? "";
  const isLast = stepIndex >= total - 1;
  const isFirst = stepIndex === 0;

  // Position the coach-mark relative to the target rect.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const placement = currentStep.placement ?? "bottom";

  let popLeft = vw / 2 - POPOVER_WIDTH / 2;
  let popTop = vh / 2 - 90;
  if (rect && (rect.width > 0 || rect.height > 0)) {
    switch (placement) {
      case "top":
        popTop = rect.top - GAP - 150;
        popLeft = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
        break;
      case "left":
        popTop = rect.top;
        popLeft = rect.left - POPOVER_WIDTH - GAP;
        break;
      case "right":
        popTop = rect.top;
        popLeft = rect.left + rect.width + GAP;
        break;
      case "bottom":
      default:
        popTop = rect.top + rect.height + GAP;
        popLeft = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
        break;
    }
  }
  // Clamp into the viewport with an 8px margin.
  popLeft = Math.max(8, Math.min(popLeft, vw - POPOVER_WIDTH - 8));
  popTop = Math.max(8, Math.min(popTop, vh - 8 - 60));

  const transition = reducedMotion ? "" : "transition-all duration-200 ease-out";
  const dim = "bg-black/60 pointer-events-auto";

  const hasRect = rect !== null && (rect.width > 0 || rect.height > 0);

  return (
    <div className="fixed inset-0 z-[300]" aria-hidden={false}>
      {/* Spotlight: dim everything except the target. When there's no measurable
          target, dim the whole screen so the centred card reads clearly. */}
      {hasRect && rect ? (
        <>
          <div className={dim} style={{ position: "fixed", top: 0, left: 0, width: "100vw", height: Math.max(0, rect.top) }} />
          <div className={dim} style={{ position: "fixed", top: rect.top + rect.height, left: 0, width: "100vw", height: Math.max(0, vh - (rect.top + rect.height)) }} />
          <div className={dim} style={{ position: "fixed", top: rect.top, left: 0, width: Math.max(0, rect.left), height: rect.height }} />
          <div className={dim} style={{ position: "fixed", top: rect.top, left: rect.left + rect.width, width: Math.max(0, vw - (rect.left + rect.width)), height: rect.height }} />
          {/* Highlight ring around the target. */}
          <div
            className={cn("pointer-events-none rounded-lg ring-2 ring-sky-400 ring-offset-2 ring-offset-zinc-950", transition)}
            style={{ position: "fixed", top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
            aria-hidden
          />
        </>
      ) : (
        <div className={dim} style={{ position: "fixed", inset: 0 }} />
      )}

      {/* Coach-mark */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
        className={cn(
          "fixed w-[340px] max-w-[calc(100vw-16px)] rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl",
          transition,
          reducedMotion ? "" : "animate-in fade-in-0 zoom-in-95"
        )}
        style={{ top: popTop, left: popLeft }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-sky-300">
            <GraduationCap className="h-4 w-4" aria-hidden />
            <span className="text-[11px] font-semibold uppercase tracking-wider">
              Step {stepIndex + 1} of {total}
            </span>
          </div>
          <button
            type="button"
            onClick={skip}
            aria-label="Skip tour"
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <h2 id="tour-step-title" className="mt-2 text-base font-semibold text-zinc-100">
          {title}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-zinc-400">{body}</p>

        {concept ? (
          <button
            type="button"
            onClick={() => openConcept(concept.id)}
            className="mt-2 text-[12px] font-medium text-sky-400 underline decoration-dotted underline-offset-2 hover:decoration-solid focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 rounded-sm"
          >
            Learn more about {concept.label} →
          </button>
        ) : null}

        {/* Progress dots */}
        <div className="mt-3 flex items-center gap-1" aria-hidden>
          {Array.from({ length: total }).map((_, i) => (
            <span
              key={i}
              className={cn("h-1.5 rounded-full transition-all", i === stepIndex ? "w-4 bg-sky-400" : "w-1.5 bg-zinc-700")}
            />
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={skip}
            className="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 rounded-sm px-1"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={back}
              disabled={isFirst}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </button>
            <button
              ref={primaryBtnRef}
              type="button"
              onClick={next}
              className="inline-flex items-center gap-1 rounded-lg border border-sky-500/60 bg-sky-500/20 px-2.5 py-1.5 text-xs font-semibold text-sky-100 transition-colors hover:bg-sky-500/30 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
            >
              {isLast ? "Done" : "Next"}
              {!isLast ? <ArrowRight className="h-3.5 w-3.5" /> : null}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
