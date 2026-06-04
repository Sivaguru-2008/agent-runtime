"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Zap, KeyRound, Bot, Play, Clapperboard, Check, Copy, ArrowRight, PartyPopper
} from "lucide-react";

/**
 * Guided onboarding (Phase 3). Five steps:
 *   1. Welcome
 *   2. Generate developer key   → POST /auth/onboarding/developer-key
 *   3. Create first agent       → POST /auth/onboarding/step first_agent_created
 *   4. Run first task           → POST /auth/onboarding/step first_task_executed
 *   5. Show replay              → POST /auth/onboarding/step first_replay_viewed
 * Each completion is tracked server-side; finishing the last step stamps
 * onboarding_completed and routes the user to the dashboard.
 *
 * All calls go through the /api/runtime proxy, which forwards the httpOnly
 * session cookie to the API's session-guarded /auth routes.
 */

interface OnboardingState {
  onboardingCompleted: string | null;
  developerKeyCreated: string | null;
  firstAgentCreated: string | null;
  firstTaskExecuted: string | null;
  firstReplayViewed: string | null;
  completedSteps: number;
  totalSteps: number;
}

const STEPS = [
  { key: "welcome", title: "Welcome", icon: Zap },
  { key: "developer_key_created", title: "Developer key", icon: KeyRound },
  { key: "first_agent_created", title: "First agent", icon: Bot },
  { key: "first_task_executed", title: "Run a task", icon: Play },
  { key: "first_replay_viewed", title: "Replay", icon: Clapperboard }
] as const;

const BTN_PRIMARY =
  "inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50 transition-colors";
const BTN_SECONDARY =
  "inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-zinc-900 border border-zinc-700 hover:border-blue-500 text-zinc-300 hover:text-blue-300 text-sm font-medium transition-colors";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md bg-zinc-800 border border-zinc-700 hover:border-blue-500 text-zinc-300 hover:text-blue-300 transition-colors"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<OnboardingState | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/runtime/auth/onboarding", { cache: "no-store" });
      if (res.ok) setState(await res.json());
    } catch {
      /* non-fatal */
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function generateKey() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/runtime/auth/onboarding/developer-key", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setApiKey(data.apiKey);
        setState(data.onboarding);
      } else if (res.status === 409) {
        setError("You already have a developer key — keys are shown only once. Continue to the next step.");
      } else {
        setError(data?.message ?? "Could not create a key.");
      }
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function markStep(stepKey: "first_agent_created" | "first_task_executed" | "first_replay_viewed") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/runtime/auth/onboarding/step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: stepKey })
      });
      if (res.ok) setState(await res.json());
    } catch {
      /* non-fatal */
    } finally {
      setBusy(false);
    }
  }

  function next() {
    setError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  async function finish() {
    await markStep("first_replay_viewed");
    router.push("/dashboard");
  }

  const Icon = STEPS[step].icon;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center px-4 py-12">
      <Link href="/" className="flex items-center gap-2 mb-8 text-zinc-400 hover:text-blue-300 transition-colors">
        <Zap className="h-5 w-5 text-blue-400" />
        <span className="font-semibold">Agent Runtime</span>
      </Link>

      {/* Step rail */}
      <div className="flex items-center gap-2 mb-10">
        {STEPS.map((s, i) => {
          const done =
            (s.key === "developer_key_created" && state?.developerKeyCreated) ||
            (s.key === "first_agent_created" && state?.firstAgentCreated) ||
            (s.key === "first_task_executed" && state?.firstTaskExecuted) ||
            (s.key === "first_replay_viewed" && state?.firstReplayViewed) ||
            (s.key === "welcome" && step > 0);
          return (
            <div key={s.key} className="flex items-center gap-2">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full border text-xs ${
                  i === step
                    ? "border-blue-500 bg-blue-600 text-white"
                    : done
                    ? "border-green-600 bg-green-900/40 text-green-300"
                    : "border-zinc-700 bg-zinc-900 text-zinc-500"
                }`}
              >
                {done ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              {i < STEPS.length - 1 && <div className="h-px w-6 bg-zinc-800" />}
            </div>
          );
        })}
      </div>

      <div className="w-full max-w-xl rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8">
        <div className="flex items-center gap-2 mb-4 text-blue-300">
          <Icon className="h-5 w-5" />
          <h1 className="text-xl font-semibold text-zinc-100">{STEPS[step].title}</h1>
        </div>

        {step === 0 && (
          <div>
            <p className="text-sm text-zinc-400 mb-6">
              You&apos;re moments away from running your first durable agent. We&apos;ll generate a developer key,
              create an agent, run a task, and show you the time-travel replay — five quick steps.
            </p>
            <button onClick={next} className={BTN_PRIMARY}>
              Get started <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {step === 1 && (
          <div>
            <p className="text-sm text-zinc-400 mb-4">
              Generate your least-privilege developer key. It&apos;s shown <strong>once</strong> — copy it now.
            </p>
            {apiKey ? (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-zinc-400">Your API key</label>
                  <CopyButton text={apiKey} />
                </div>
                <code className="block w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-700 text-sm font-mono text-green-300 break-all">
                  {apiKey}
                </code>
              </div>
            ) : (
              <button onClick={generateKey} disabled={busy} className={`${BTN_PRIMARY} mb-2`}>
                <KeyRound className="h-4 w-4" /> {busy ? "Generating…" : "Generate developer key"}
              </button>
            )}
            {(apiKey || state?.developerKeyCreated) && (
              <button onClick={next} className={BTN_SECONDARY}>
                Next <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        {step === 2 && (
          <div>
            <p className="text-sm text-zinc-400 mb-4">
              Create your first agent. Use the SDK or the dashboard, then mark this step done.
            </p>
            <pre className="w-full px-4 py-3 mb-4 rounded-lg bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-300 overflow-x-auto">
              <code>{`const agent = await client.createAgent({
  name: "my-first-agent",
  goal: "Summarise incident reports"
});`}</code>
            </pre>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  await markStep("first_agent_created");
                  next();
                }}
                disabled={busy}
                className={BTN_PRIMARY}
              >
                <Bot className="h-4 w-4" /> I created an agent
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <p className="text-sm text-zinc-400 mb-4">Run your first task against the agent you just created.</p>
            <pre className="w-full px-4 py-3 mb-4 rounded-lg bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-300 overflow-x-auto">
              <code>{`const execution = await client.createExecution({
  agentId: agent.id,
  prompt: "Summarise the latest incident report"
});
await client.waitForExecution(execution.id);`}</code>
            </pre>
            <button
              onClick={async () => {
                await markStep("first_task_executed");
                next();
              }}
              disabled={busy}
              className={BTN_PRIMARY}
            >
              <Play className="h-4 w-4" /> I ran a task
            </button>
          </div>
        )}

        {step === 4 && (
          <div>
            <p className="text-sm text-zinc-400 mb-4">
              Every execution is recorded. Open the time-travel replay to inspect each step deterministically.
            </p>
            <Link href="/replays" className={`${BTN_SECONDARY} mb-4`}>
              <Clapperboard className="h-4 w-4" /> Open a replay
            </Link>
            <div className="mt-2">
              <button onClick={finish} disabled={busy} className={BTN_PRIMARY}>
                <PartyPopper className="h-4 w-4" /> Finish onboarding
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 text-sm text-yellow-300/90 bg-yellow-950/20 border border-yellow-900/60 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
      </div>

      <Link href="/dashboard" className="text-xs text-zinc-600 mt-6 hover:text-zinc-400">
        Skip for now →
      </Link>
    </div>
  );
}
