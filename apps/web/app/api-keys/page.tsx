"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AccountBar } from "@/components/auth/account-bar";
import { KeyRound, ArrowRight } from "lucide-react";

/**
 * API keys (protected route). A developer key is minted once during onboarding
 * (shown a single time). This page surfaces the linked tenant and routes users
 * who have not yet provisioned a key back into onboarding.
 */
interface Me {
  user?: { tenantId: string | null };
  onboarding?: { developerKeyCreated: string | null };
}

export default function ApiKeysPage() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => setMe(null));
  }, []);

  const hasKey = Boolean(me?.onboarding?.developerKeyCreated || me?.user?.tenantId);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AccountBar />
      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-semibold mb-1 flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-blue-400" /> API keys
        </h1>
        <p className="text-sm text-zinc-500 mb-6">
          Keys are least-privilege <code className="font-mono text-zinc-400">developer</code> credentials, shown once
          at creation and stored only as a hash.
        </p>

        {hasKey ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
            <div className="text-sm text-zinc-300 mb-1">Active developer key</div>
            <div className="text-xs text-zinc-500">
              Linked tenant <span className="font-mono text-zinc-300">{me?.user?.tenantId ?? "—"}</span>. The raw key
              was shown once at creation — rotate it via the operator console if it&apos;s lost.
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
            <div className="text-sm text-zinc-300 mb-3">You don&apos;t have a developer key yet.</div>
            <Link
              href="/onboarding"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
            >
              Generate one in onboarding <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
