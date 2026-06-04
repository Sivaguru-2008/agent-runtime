"use client";

import { useState } from "react";
import Link from "next/link";
import { Zap, Copy, Check, KeyRound, ArrowRight } from "lucide-react";

/**
 * Self-serve onboarding — the public activation funnel landing.
 *
 * Posts to the API's POST /signup (via the /api/runtime proxy) to mint a
 * least-privilege `developer` key + a fresh tenant, then shows the key ONCE
 * with a copy-paste SDK quickstart. This is the page that turns an interested
 * developer into an activated user without a human in the loop.
 */

interface SignupSuccess {
  tenantId: string;
  role: string;
  plan: string;
  apiKey: string;
  keyPrefix: string;
  rateLimitRpm: number;
}

/**
 * Lift acquisition attribution off the landing URL + referrer at submit time.
 * UTM params are perishable — captured here once, persisted server-side. Values
 * are read defensively (SSR-safe) and omitted when absent so the request body
 * stays clean.
 */
function readAttribution(): {
  source?: string;
  utm: {
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmTerm?: string;
    utmContent?: string;
  };
  referrer?: string;
  landingPath?: string;
} {
  if (typeof window === "undefined") return { utm: {} };
  const p = new URLSearchParams(window.location.search);
  const val = (k: string) => p.get(k)?.trim() || undefined;
  return {
    source: val("utm_source") ?? val("source"),
    utm: {
      utmSource: val("utm_source"),
      utmMedium: val("utm_medium"),
      utmCampaign: val("utm_campaign"),
      utmTerm: val("utm_term"),
      utmContent: val("utm_content")
    },
    referrer: document.referrer || undefined,
    landingPath: window.location.pathname || undefined
  };
}

function CopyButton({ text, label }: { text: string; label?: string }) {
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
      {copied ? "Copied" : label ?? "Copy"}
    </button>
  );
}

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [organization, setOrganization] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SignupSuccess | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const attribution = readAttribution();
    try {
      const res = await fetch("/api/runtime/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          organization: organization.trim() || undefined,
          inviteCode: inviteCode.trim() || undefined,
          // `source` prefers an explicit ?utm_source/?source on the landing URL
          // and falls back to "landing" so the existing attribution is unchanged
          // when no campaign params are present.
          source: attribution.source ?? "landing",
          ...attribution.utm,
          referrer: attribution.referrer,
          landingPath: attribution.landingPath
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message ?? "Signup failed. Please try again.");
        return;
      }
      setResult(data as SignupSuccess);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const quickstart = result
    ? `import { AgentRuntimeClient } from "@agent-platform/sdk";

const client = new AgentRuntimeClient({
  baseUrl: "${typeof window !== "undefined" ? window.location.origin : "https://your-api"}",
  apiKey: "${result.apiKey}"
});

const agent = await client.createAgent({
  name: "my-first-agent",
  goal: "Summarise incident reports"
});
const execution = await client.createExecution({
  agentId: agent.id,
  prompt: "Summarise the latest incident report"
});
const final = await client.waitForExecution(execution.id);
console.log(final.status, final.output);`
    : "";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center px-4 py-16">
      <Link href="/" className="flex items-center gap-2 mb-10 text-zinc-400 hover:text-blue-300 transition-colors">
        <Zap className="h-5 w-5 text-blue-400" />
        <span className="font-semibold">Agent Runtime</span>
      </Link>

      {!result ? (
        <div className="w-full max-w-md">
          <h1 className="text-2xl font-semibold mb-1">Get your API key</h1>
          <p className="text-sm text-zinc-400 mb-8">
            Spin up a tenant and a developer key in seconds. No credit card.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Work email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 focus:border-blue-500 focus:outline-none text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                Organization <span className="text-zinc-600">(optional)</span>
              </label>
              <input
                type="text"
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                placeholder="Acme Inc"
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 focus:border-blue-500 focus:outline-none text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                Invite code
              </label>
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Provided by the team"
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 focus:border-blue-500 focus:outline-none text-sm font-mono"
              />
            </div>

            {error && (
              <div className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm transition-colors"
            >
              {submitting ? "Creating…" : "Create my key"}
              {!submitting && <ArrowRight className="h-4 w-4" />}
            </button>
          </form>
        </div>
      ) : (
        <div className="w-full max-w-2xl">
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className="h-5 w-5 text-green-400" />
            <h1 className="text-2xl font-semibold">You're in.</h1>
          </div>
          <p className="text-sm text-zinc-400 mb-6">
            Tenant <span className="font-mono text-zinc-300">{result.tenantId}</span> · role{" "}
            <span className="font-mono text-zinc-300">{result.role}</span> · {result.rateLimitRpm} req/min
          </p>

          <div className="rounded-lg border border-yellow-900/60 bg-yellow-950/20 px-4 py-3 mb-6">
            <p className="text-xs text-yellow-300/90">
              ⚠ This key is shown <strong>once</strong>. Copy it now and store it in your secret manager — it cannot be recovered.
            </p>
          </div>

          <div className="mb-6">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-zinc-400">Your API key</label>
              <CopyButton text={result.apiKey} label="Copy key" />
            </div>
            <code className="block w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-700 text-sm font-mono text-green-300 break-all">
              {result.apiKey}
            </code>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-zinc-400">Run your first agent</label>
              <CopyButton text={quickstart} label="Copy code" />
            </div>
            <pre className="w-full px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-300 overflow-x-auto">
              <code>{`npm install @agent-platform/sdk\n\n${quickstart}`}</code>
            </pre>
          </div>

          <div className="mt-8 flex items-center gap-3">
            <Link
              href="/operator"
              className="flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg bg-zinc-900 border border-zinc-700 hover:border-blue-500 text-zinc-300 hover:text-blue-300 transition-colors"
            >
              <Zap className="h-4 w-4" />
              Open the dashboard
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
