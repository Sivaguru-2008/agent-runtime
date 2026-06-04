"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Users, UserPlus, LogIn, Activity, KeyRound, Bot, Play, Clapperboard,
  TrendingDown, ArrowRight, RefreshCw
} from "lucide-react";

/**
 * Founder admin dashboard (Phase 6 + Phase 9).
 *
 * Reads the founder-gated analytics endpoints through the /api/runtime proxy:
 *   /admin/founder/overview   — totals, active users, activation metrics, feed
 *   /admin/founder/funnel     — activation/conversion funnel + rates
 *   /admin/founder/insights   — DAU/WAU/MAU, averages, top/at-risk users
 *
 * Access is enforced three ways: the web middleware (founder claim), the proxy
 * (forwards the session cookie), and the API (session guard + is_founder).
 */

interface Overview {
  totalUsers: number;
  newUsersToday: number;
  newUsersThisWeek: number;
  totalLogins: number;
  activeUsers24h: number;
  activeUsers7d: number;
  activeUsers30d: number;
  activation: { developerKeysCreated: number; agentsCreated: number; tasksExecuted: number; replaysViewed: number };
  recentActivity: { eventType: string; occurredAt: string; email: string | null; name: string | null }[];
}
interface FunnelStage { stage: string; count: number; stepConversion: number; overallConversion: number }
interface Funnel {
  stages: FunnelStage[];
  signupRate: number;
  activationRate: number;
  retentionRate: number;
  biggestDropOff: { from: string; to: string; lostPct: number } | null;
}
interface UserUsage {
  userId: string; email: string; name: string | null; loginCount: number;
  lastLoginAt: string | null; agentCount: number; taskCount: number; activated: boolean;
}
interface Insights {
  dau: number; wau: number; mau: number; activationRate: number;
  avgTasksPerUser: number; avgAgentsPerUser: number;
  topUsers: UserUsage[]; recentlyActive: UserUsage[];
  signedUpNeverActivated: UserUsage[]; activatedNeverReturned: UserUsage[];
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

function Stat({ icon: Icon, label, value, sub }: { icon: any; label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center gap-2 text-zinc-500 text-xs mb-2">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="text-2xl font-semibold text-zinc-100">{value}</div>
      {sub && <div className="text-xs text-zinc-500 mt-1">{sub}</div>}
    </div>
  );
}

export default function FounderDashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [o, f, i] = await Promise.all([
        fetch("/api/runtime/admin/founder/overview", { cache: "no-store" }),
        fetch("/api/runtime/admin/founder/funnel", { cache: "no-store" }),
        fetch("/api/runtime/admin/founder/insights", { cache: "no-store" })
      ]);
      if (o.status === 401 || o.status === 403) {
        setError("Founder access required.");
        return;
      }
      if (o.ok) setOverview(await o.json());
      if (f.ok) setFunnel(await f.json());
      if (i.ok) setInsights(await i.json());
    } catch {
      setError("Could not load founder metrics.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const maxStage = funnel ? Math.max(...funnel.stages.map((s) => s.count), 1) : 1;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-6 py-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold">Founder Dashboard</h1>
            <p className="text-sm text-zinc-500">Who signed up, who logged in, who activated, who&apos;s using it.</p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/founder/users"
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-zinc-900 border border-zinc-700 hover:border-blue-500 text-zinc-300 hover:text-blue-300 rounded-lg transition-colors"
            >
              <Users className="h-3.5 w-3.5" /> User directory <ArrowRight className="h-3 w-3" />
            </Link>
            <button
              onClick={load}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-zinc-900 border border-zinc-700 hover:border-blue-500 text-zinc-400 rounded-lg transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-4 py-3 mb-6">{error}</div>
        )}
        {loading && !overview && <p className="text-sm text-zinc-500">Loading metrics…</p>}

        {overview && (
          <>
            {/* User + activity totals */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <Stat icon={Users} label="Total Users" value={overview.totalUsers} />
              <Stat icon={UserPlus} label="New Today" value={overview.newUsersToday} sub={`${overview.newUsersThisWeek} this week`} />
              <Stat icon={LogIn} label="Total Logins" value={overview.totalLogins} />
              <Stat icon={Activity} label="Active (24h)" value={overview.activeUsers24h} sub={`${overview.activeUsers7d} / 7d · ${overview.activeUsers30d} / 30d`} />
            </div>

            {/* Activation metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
              <Stat icon={KeyRound} label="Developer Keys" value={overview.activation.developerKeysCreated} />
              <Stat icon={Bot} label="Agents Created" value={overview.activation.agentsCreated} />
              <Stat icon={Play} label="Tasks Executed" value={overview.activation.tasksExecuted} />
              <Stat icon={Clapperboard} label="Replays Viewed" value={overview.activation.replaysViewed} />
            </div>
          </>
        )}

        {/* Conversion funnel */}
        {funnel && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-zinc-200">Activation funnel</h2>
              <div className="flex gap-4 text-xs text-zinc-500">
                <span>Signup rate <b className="text-zinc-300">{pct(funnel.signupRate)}</b></span>
                <span>Activation rate <b className="text-green-300">{pct(funnel.activationRate)}</b></span>
                <span>Retention <b className="text-zinc-300">{pct(funnel.retentionRate)}</b></span>
              </div>
            </div>
            <div className="space-y-2">
              {funnel.stages.map((s) => (
                <div key={s.stage} className="flex items-center gap-3">
                  <div className="w-32 text-xs text-zinc-400 text-right">{s.stage}</div>
                  <div className="flex-1 bg-zinc-950 rounded-md h-6 overflow-hidden border border-zinc-800">
                    <div
                      className="h-full bg-blue-600/70 flex items-center px-2"
                      style={{ width: `${Math.max((s.count / maxStage) * 100, s.count > 0 ? 4 : 0)}%` }}
                    >
                      <span className="text-[11px] text-white font-medium">{s.count}</span>
                    </div>
                  </div>
                  <div className="w-16 text-xs text-zinc-500 text-right">{pct(s.overallConversion)}</div>
                </div>
              ))}
            </div>
            {funnel.biggestDropOff && (
              <div className="mt-4 flex items-center gap-2 text-xs text-amber-300/90">
                <TrendingDown className="h-3.5 w-3.5" />
                Biggest drop-off: <b>{funnel.biggestDropOff.from} → {funnel.biggestDropOff.to}</b>
                ({pct(funnel.biggestDropOff.lostPct)} lost)
              </div>
            )}
          </div>
        )}

        {/* Operational insight */}
        {insights && (
          <div className="grid md:grid-cols-2 gap-6 mb-8">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
              <h2 className="text-sm font-semibold text-zinc-200 mb-4">Operational insight</h2>
              <div className="grid grid-cols-3 gap-3 mb-4">
                <Stat icon={Activity} label="DAU" value={insights.dau} />
                <Stat icon={Activity} label="WAU" value={insights.wau} />
                <Stat icon={Activity} label="MAU" value={insights.mau} />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Stat icon={Play} label="Avg tasks/user" value={insights.avgTasksPerUser.toFixed(1)} />
                <Stat icon={Bot} label="Avg agents/user" value={insights.avgAgentsPerUser.toFixed(1)} />
                <Stat icon={TrendingDown} label="Activation" value={pct(insights.activationRate)} />
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
              <h2 className="text-sm font-semibold text-zinc-200 mb-3">Top users</h2>
              <ul className="space-y-1.5">
                {insights.topUsers.slice(0, 6).map((u) => (
                  <li key={u.userId} className="flex items-center justify-between text-xs">
                    <span className="text-zinc-300 truncate">{u.name || u.email}</span>
                    <span className="text-zinc-500">{u.taskCount} tasks · {u.agentCount} agents</span>
                  </li>
                ))}
                {insights.topUsers.length === 0 && <li className="text-xs text-zinc-600">No usage yet.</li>} {/* explain-coverage-ignore: founder dashboard is admin-only and does not use explainability system */}
              </ul>
              <div className="grid grid-cols-2 gap-4 mt-4 pt-4 border-t border-zinc-800">
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Signed up, never activated</div>
                  <div className="text-lg font-semibold text-amber-300">{insights.signedUpNeverActivated.length}</div>
                </div>
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Activated, never returned</div>
                  <div className="text-lg font-semibold text-amber-300">{insights.activatedNeverReturned.length}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Recent activity feed */}
        {overview && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
            <h2 className="text-sm font-semibold text-zinc-200 mb-3">Recent activity</h2>
            <ul className="divide-y divide-zinc-800">
              {overview.recentActivity.map((a, i) => (
                <li key={i} className="flex items-center justify-between py-2 text-xs">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-blue-300">{a.eventType}</span>
                    <span className="text-zinc-400">{a.name || a.email || "anonymous"}</span>
                  </span>
                  <span className="text-zinc-600">{fmt(a.occurredAt)}</span>
                </li>
              ))}
              {overview.recentActivity.length === 0 && <li className="py-2 text-xs text-zinc-600">No activity yet.</li>} {/* explain-coverage-ignore: founder dashboard is admin-only and does not use explainability system */}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
