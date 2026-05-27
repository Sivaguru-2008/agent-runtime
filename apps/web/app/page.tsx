import { ObservabilityDashboard } from "@/components/dashboard/observability-dashboard";
import Link from "next/link";
import { Zap } from "lucide-react";

export default function Page() {
  return (
    <div className="relative">
      {/* Phase 4: Operator Platform shortcut */}
      <div className="fixed top-3 right-4 z-50">
        <Link
          href="/operator"
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
