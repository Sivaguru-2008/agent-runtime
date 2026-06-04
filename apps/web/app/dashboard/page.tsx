import { ObservabilityDashboard } from "@/components/dashboard/observability-dashboard";
import { AccountBar } from "@/components/auth/account-bar";

/**
 * Authenticated dashboard (Phase 2 protected route + the post-onboarding
 * landing). Wraps the existing observability dashboard with the account bar.
 */
export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-zinc-950">
      <AccountBar />
      <ObservabilityDashboard />
    </div>
  );
}
