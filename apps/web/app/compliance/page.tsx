import type { Metadata } from "next";
import Link from "next/link";
import {
  ShieldCheck,
  Fingerprint,
  RotateCcw,
  Search,
  AlertTriangle,
  FileCheck,
  ArrowRight,
  Scale,
  Landmark,
  Repeat
} from "lucide-react";

/**
 * /compliance — the proof-layer positioning page.
 *
 * Audience: VPs of AI Risk, compliance officers, CROs at banks/fintechs and
 * AI-liability insurers — NOT developers. The page sells one thing: when a
 * regulator, auditor, or court asks "prove what your AI agent did and why",
 * audit logs are not proof (they're forgeable) — a fenced, deterministically
 * replayable execution trace is.
 *
 * Static by design: no client state, no API calls, renders even when the
 * runtime is down. The only personalization is FOUNDER_EMAIL, which follows
 * the same REPLACE_FOUNDER_EMAIL token convention as docs/gtm/landing.
 */

// Swap before sending the page to a prospect (same token as docs/gtm/landing).
const FOUNDER_EMAIL = "REPLACE_FOUNDER_EMAIL";
const DEMO_MAILTO = `mailto:${FOUNDER_EMAIL}?subject=${encodeURIComponent(
  "Compliance demo — provable AI agent execution"
)}`;

export const metadata: Metadata = {
  title: "Provable AI Agent Execution | Runloop",
  description:
    "Cryptographically unforgeable execution traces for AI agents. When a regulator asks what your agent did and why, show proof — not logs."
};

const SCENARIOS = [
  {
    icon: AlertTriangle,
    title: "The double charge",
    question: "“Your payment agent charged a customer twice. Prove what happened.”",
    answer:
      "The fenced trace shows the retry arrived, the idempotency guard fired, and the second charge never executed — or exactly where it did. Signed, ordered, complete. Reconstructed in minutes, not weeks of log archaeology."
  },
  {
    icon: Scale,
    title: "The contested decision",
    question: "“Why did the agent reject this application? Show the auditor the decision logic.”",
    answer:
      "Replay the exact execution: the inputs the agent saw, the configuration active at that moment, the rule that fired and the ones that didn't. Deterministic replay reproduces the same decision from the same trace — that's evidence, not narrative."
  },
  {
    icon: Repeat,
    title: "One-off, or 500 more times?",
    question: "“Is this incident isolated — or systemic and about to recur?”",
    answer:
      "Group executions by decision signature across the fleet. See immediately whether the failing pattern is a single transaction or a class of them — the question remediation teams are never staffed to answer."
  }
] as const;

const STEPS = [
  {
    icon: Fingerprint,
    title: "Fenced execution",
    body:
      "Every tool side effect runs through a fencing protocol: events cannot be inserted, deleted, or reordered after the fact, and side effects execute exactly once. The trace is tamper-evident by construction — not by policy."
  },
  {
    icon: RotateCcw,
    title: "Deterministic replay",
    body:
      "Re-run any execution from its trace and get the same decisions, token for token. A replay that provably matches the original is the difference between “what probably happened” and proof."
  },
  {
    icon: Search,
    title: "Forensic reconstruction",
    body:
      "Walk an auditor through the causal chain: input → active config → decision → side effect, with root-cause analysis across the whole execution. Export the trace and its signatures as the audit artifact."
  }
] as const;

export default function CompliancePage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-200">
      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pt-20 pb-16 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-700/50 bg-emerald-950/40 px-4 py-1.5 text-xs font-medium tracking-wide text-emerald-300">
          <ShieldCheck className="h-3.5 w-3.5" />
          For AI risk, compliance, and audit teams
        </div>
        <h1 className="mx-auto max-w-3xl text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl">
          When the regulator asks what your AI agent did,
          <span className="text-emerald-400"> show proof — not logs.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-zinc-400">
          Application logs can be edited after the fact. Re-runs drift. Runloop records every agent
          execution as a cryptographically fenced, deterministically replayable trace — an audit
          artifact that shows exactly what the agent did, why, and that it could not have been forged.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href={DEMO_MAILTO}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-950/50 transition-colors hover:bg-emerald-500"
          >
            Book a 30-minute compliance demo
            <ArrowRight className="h-4 w-4" />
          </a>
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-6 py-3 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
          >
            Run it on your own agent
          </Link>
        </div>
      </section>

      {/* The problem framing */}
      <section className="border-y border-zinc-900 bg-zinc-900/40">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <p className="mx-auto max-w-3xl text-center text-base leading-relaxed text-zinc-400">
            Remediation is the easy half — reverse the charge, make the customer whole. The question
            that follows is the one nobody is staffed for:{" "}
            <span className="font-semibold text-zinc-200">
              “Prove what the system did and why — and tell me whether it's about to happen 500 more
              times.”
            </span>{" "}
            Logs written to debug crashes were never designed to reconstruct a decision.
          </p>
        </div>
      </section>

      {/* Scenarios */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <h2 className="text-center text-2xl font-semibold text-white">
          Three questions you'll be asked after an incident
        </h2>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {SCENARIOS.map((s) => (
            <div
              key={s.title}
              className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/60 p-6"
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-emerald-800/60 bg-emerald-950/40 text-emerald-400">
                <s.icon className="h-5 w-5" />
              </div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">
                {s.title}
              </h3>
              <p className="mt-2 text-sm italic leading-relaxed text-zinc-400">{s.question}</p>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">{s.answer}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-zinc-900 bg-zinc-900/40">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-center text-2xl font-semibold text-white">
            Why this is proof, not telemetry
          </h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <div key={step.title} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-6">
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-emerald-400">
                    <step.icon className="h-5 w-5" />
                  </div>
                  <span className="font-mono text-xs text-zinc-500">0{i + 1}</span>
                </div>
                <h3 className="text-base font-semibold text-zinc-100">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">{step.body}</p>
              </div>
            ))}
          </div>
          <p className="mx-auto mt-10 max-w-2xl text-center text-sm leading-relaxed text-zinc-500">
            Observability tools show you what happened. Durable-execution engines re-run work. Neither
            yields a trace an auditor can rely on:{" "}
            <span className="text-zinc-300">
              logs are mutable, and non-deterministic replays diverge.
            </span>{" "}
            Fenced execution plus deterministic replay closes both gaps in one artifact.
          </p>
        </div>
      </section>

      {/* Regulatory context */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-8">
          <div className="flex flex-col items-start gap-6 md:flex-row md:items-center">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-sky-800/60 bg-sky-950/40 text-sky-400">
              <Landmark className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">
                The audit requirement is already here
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                The EU AI Act mandates record-keeping and traceability for high-risk AI systems.
                US banking supervisors expect model-risk governance to extend to AI agents acting on
                customer accounts. The teams deploying agents for settlements, underwriting, and
                disputes will be asked to evidence agent behavior —{" "}
                <span className="text-zinc-200">
                  the only open question is whether the evidence will hold up.
                </span>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-zinc-900 bg-zinc-900/40">
        <div className="mx-auto max-w-3xl px-6 py-16 text-center">
          <FileCheck className="mx-auto h-8 w-8 text-emerald-400" />
          <h2 className="mt-4 text-2xl font-semibold text-white">
            Bring us one incident you couldn't fully explain
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-zinc-400">
            In 30 minutes we'll show the same incident class running through fenced execution — and
            the exact artifact you'd hand the auditor. No deployment required for the first
            conversation.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={DEMO_MAILTO}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-500"
            >
              Book the demo
              <ArrowRight className="h-4 w-4" />
            </a>
            <Link
              href="/"
              className="text-sm text-zinc-500 underline-offset-4 transition-colors hover:text-zinc-300 hover:underline"
            >
              Or explore the live console →
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
