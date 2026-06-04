import { ObservabilityDashboard } from "@/components/dashboard/observability-dashboard";
import { VisitTracker } from "@/components/system/visit-tracker";
import Link from "next/link";
import { Zap, KeyRound, LogIn } from "lucide-react";

export default function Page() {
  return (
    <div className="relative">
      {/* Top-of-funnel: record an anonymous visit (no-op unless USER_AUTH_ENABLED). */}
      <VisitTracker />
      {/* Phase 4: Operator Platform shortcut + self-serve onboarding CTA + sign in */}
      <div className="fixed top-3 right-4 z-50 flex items-center gap-2">
        <Link
          href="/login"
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-zinc-900 border border-zinc-700 hover:border-blue-500 text-zinc-300 hover:text-blue-300 rounded-lg transition-colors"
        >
          <LogIn className="h-3 w-3" />
          Sign in
        </Link>
        <Link
          href="/signup"
          data-tour="signup-link"
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          <KeyRound className="h-3 w-3" />
          Get API key
        </Link>
        <Link
          href="/operator"
          data-tour="operator-link"
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-zinc-900 border border-zinc-700 hover:border-blue-500 text-zinc-400 hover:text-blue-300 rounded-lg transition-colors"
        >
          <Zap className="h-3 w-3" />
          Operator Platform
        </Link>
      </div>
      <ObservabilityDashboard />
    </div>
  );
}
