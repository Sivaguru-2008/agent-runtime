"use client";

/**
 * Layer 3 — Click-to-learn side panel.
 *
 * A single instance is mounted at the app root. Any ExplainLabel (or
 * `openConcept(id)`) opens it for a concept, showing the full knowledge entry:
 * definition, how it's calculated, where the data comes from, why it's tracked,
 * what affects it, healthy/warning/critical ranges, how to fix problems,
 * examples, the "why did this happen?" questions, and an FAQ.
 *
 * Accessibility: role="dialog", aria-modal, labelled by its heading, closable
 * with the × button, a backdrop click, or Escape (handled in the provider).
 * Mobile: full-width sheet on small screens, a 30rem panel on large.
 */

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { getConcept } from "@/lib/explain/registry";
import type { Concept } from "@/lib/explain/types";
import { useExplainMode } from "./explain-mode";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-sky-400/90">{title}</h3>
      <div className="text-sm leading-relaxed text-zinc-300">{children}</div>
    </section>
  );
}

function RangeRow({ tone, label, value }: { tone: string; label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone}`} aria-hidden />
      <span className="text-zinc-400">
        <span className="font-medium text-zinc-200">{label}:</span> {value}
      </span>
    </div>
  );
}

function Body({ concept }: { concept: Concept }) {
  return (
    <div className="space-y-5">
      <Section title="What this is">
        <p>{concept.what}</p>
      </Section>

      <Section title="Why it exists">
        <p>{concept.why}</p>
      </Section>

      <Section title="Why you should care">
        <p>{concept.whyCare}</p>
      </Section>

      {concept.howCalculated ? (
        <Section title="How it's calculated">
          <p>{concept.howCalculated}</p>
        </Section>
      ) : null}

      {concept.dataSource ? (
        <Section title="Where the data comes from">
          <p>{concept.dataSource}</p>
        </Section>
      ) : null}

      {concept.affectedBy?.length ? (
        <Section title="What affects it">
          <ul className="list-disc space-y-1 pl-5">
            {concept.affectedBy.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {concept.healthy || concept.warning || concept.critical ? (
        <Section title="Healthy · Warning · Critical">
          <div className="space-y-1.5">
            <RangeRow tone="bg-emerald-400" label="Healthy" value={concept.healthy} />
            <RangeRow tone="bg-amber-400" label="Warning" value={concept.warning} />
            <RangeRow tone="bg-rose-400" label="Critical" value={concept.critical} />
          </div>
        </Section>
      ) : null}

      {concept.good || concept.bad ? (
        <Section title="Reading the graph">
          <div className="space-y-1.5">
            <RangeRow tone="bg-emerald-400" label="Good looks like" value={concept.good} />
            <RangeRow tone="bg-rose-400" label="Bad looks like" value={concept.bad} />
          </div>
        </Section>
      ) : null}

      {concept.howToFix?.length ? (
        <Section title="How to fix problems">
          <ol className="list-decimal space-y-1 pl-5">
            {concept.howToFix.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </Section>
      ) : null}

      {concept.example ? (
        <Section title="Example">
          <p className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-zinc-300">{concept.example}</p>
        </Section>
      ) : null}

      {concept.whyQuestions?.length ? (
        <Section title="Why did this happen?">
          <div className="space-y-2.5">
            {concept.whyQuestions.map((item) => (
              <div key={item.q}>
                <div className="font-medium text-zinc-200">{item.q}</div>
                <p className="text-zinc-400">{item.a}</p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {concept.faq?.length ? (
        <Section title="FAQ">
          <div className="space-y-2.5">
            {concept.faq.map((item) => (
              <div key={item.q}>
                <div className="font-medium text-zinc-200">{item.q}</div>
                <p className="text-zinc-400">{item.a}</p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

export function ExplainPanel() {
  const { activeConceptId, closeConcept } = useExplainMode();
  const concept = activeConceptId ? getConcept(activeConceptId) : undefined;

  if (!activeConceptId || !concept) return null;

  return (
    <div className="fixed inset-0 z-[200] flex justify-end" role="dialog" aria-modal="true" aria-labelledby="explain-panel-title">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close explanation"
        onClick={closeConcept}
        className="absolute inset-0 bg-black/50 backdrop-blur-[1px] animate-in fade-in-0"
      />
      {/* Panel */}
      <div className="relative h-full w-full max-w-full overflow-y-auto border-l border-zinc-800 bg-zinc-950 shadow-2xl sm:w-[30rem] animate-in slide-in-from-right-4 fade-in-0">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-5 py-4 backdrop-blur">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Explanation</div>
            <h2 id="explain-panel-title" className="text-lg font-semibold text-zinc-100">
              {concept.label}
            </h2>
            <p className="mt-0.5 text-sm text-zinc-400">{concept.short}</p>
          </div>
          <button
            type="button"
            onClick={closeConcept}
            aria-label="Close"
            className="shrink-0 rounded-md border border-zinc-800 p-1.5 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-5">
          <Body concept={concept} />
        </div>
      </div>
    </div>
  );
}
