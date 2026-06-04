"use client";

import { useEffect, useState } from "react";
import { AccountBar } from "@/components/auth/account-bar";

/**
 * Account settings (protected route). Shows the signed-in identity and
 * onboarding progress, sourced from /api/auth/me.
 */
interface Me {
  user?: { email: string; name: string | null; tenantId: string | null; createdAt: string; loginCount: number; lastLoginAt: string | null };
  onboarding?: { completedSteps: number; totalSteps: number; onboardingCompleted: string | null };
}

export default function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => setMe(null));
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AccountBar />
      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-semibold mb-6">Settings</h1>
        {me?.user ? (
          <div className="space-y-4">
            <Row label="Name" value={me.user.name || "—"} />
            <Row label="Email" value={me.user.email} />
            <Row label="Tenant" value={me.user.tenantId || "Not provisioned yet"} />
            <Row label="Member since" value={new Date(me.user.createdAt).toLocaleDateString()} />
            <Row label="Logins" value={String(me.user.loginCount)} />
            <Row label="Last login" value={me.user.lastLoginAt ? new Date(me.user.lastLoginAt).toLocaleString() : "—"} />
            <Row
              label="Onboarding"
              value={me.onboarding ? `${me.onboarding.completedSteps}/${me.onboarding.totalSteps}${me.onboarding.onboardingCompleted ? " · complete" : ""}` : "—"}
            />
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Loading…</p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
      <span className="text-sm text-zinc-500">{label}</span>
      <span className="text-sm text-zinc-200 font-mono">{value}</span>
    </div>
  );
}
