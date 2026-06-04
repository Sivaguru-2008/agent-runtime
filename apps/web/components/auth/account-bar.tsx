"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogOut, LayoutDashboard, ShieldCheck } from "lucide-react";

/**
 * Thin top bar for the authenticated app: shows the signed-in user, a link to
 * the founder dashboard (founders only), and a sign-out button that clears the
 * httpOnly session cookie via /api/auth/logout.
 */

interface Me {
  user?: { email: string; name: string | null; isFounder: boolean; profilePicture: string | null };
}

export function AccountBar() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMe(d))
      .catch(() => setMe(null));
  }, []);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-40">
      <Link href="/dashboard" className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
        <LayoutDashboard className="h-4 w-4 text-blue-400" /> Runloop Console
      </Link>
      <div className="flex items-center gap-3">
        {me?.user?.isFounder && (
          <Link
            href="/founder"
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 bg-zinc-900 border border-zinc-700 hover:border-blue-500 text-zinc-300 hover:text-blue-300 rounded-lg transition-colors"
          >
            <ShieldCheck className="h-3.5 w-3.5" /> Founder
          </Link>
        )}
        {me?.user && (
          <span className="text-xs text-zinc-500 hidden sm:inline">{me.user.name || me.user.email}</span>
        )}
        <button
          onClick={signOut}
          className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 bg-zinc-900 border border-zinc-700 hover:border-red-500/60 text-zinc-400 hover:text-red-300 rounded-lg transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </button>
      </div>
    </div>
  );
}
