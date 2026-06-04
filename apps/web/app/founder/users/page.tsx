"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Search, CheckCircle2, XCircle } from "lucide-react";

/**
 * User directory (Phase 7). Searchable / filterable / sortable table of every
 * human, with per-user activation status and agent/task counts so the founder
 * can spot power users and stalled signups. Reads the founder-gated
 * /admin/founder/users endpoint through the proxy.
 */

interface DirectoryUser {
  userId: string;
  name: string | null;
  email: string;
  signupDate: string;
  lastLoginAt: string | null;
  loginCount: number;
  developerKeyCreated: boolean;
  agentCount: number;
  taskCount: number;
  activated: boolean;
}
interface DirectoryResult { users: DirectoryUser[]; total: number; limit: number; offset: number }

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

type SortKey = "created_at" | "last_login_at" | "login_count" | "email" | "agent_count" | "task_count";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "created_at", label: "Signup date" },
  { key: "last_login_at", label: "Last login" },
  { key: "login_count", label: "Login count" },
  { key: "agent_count", label: "Agents" },
  { key: "task_count", label: "Tasks" },
  { key: "email", label: "Email" }
];

const FILTERS = [
  { key: "all", label: "All" },
  { key: "activated", label: "Activated" },
  { key: "not_activated", label: "Not activated" },
  { key: "has_key", label: "Has key" }
];

export default function UserDirectory() {
  const [data, setData] = useState<DirectoryResult | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<SortKey>("created_at");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ filter, sort, direction, limit: "100" });
    if (search.trim()) params.set("search", search.trim());
    try {
      const res = await fetch(`/api/runtime/admin/founder/users?${params.toString()}`, { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        setError("Founder access required.");
        return;
      }
      if (res.ok) setData(await res.json());
    } catch {
      setError("Could not load users.");
    } finally {
      setLoading(false);
    }
  }, [filter, sort, direction, search]);

  // Reload when filter/sort/direction change; debounce the search box.
  useEffect(() => {
    void load();
  }, [filter, sort, direction]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleSort(key: SortKey) {
    if (sort === key) setDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDirection("desc");
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-6 py-8">
      <div className="max-w-6xl mx-auto">
        <Link href="/founder" className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-blue-300 mb-4">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to dashboard
        </Link>
        <h1 className="text-2xl font-semibold mb-1">User directory</h1>
        <p className="text-sm text-zinc-500 mb-6">
          {data ? `${data.total} users` : "Loading…"} · search, filter and sort to find power users.
        </p>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or email"
              className="pl-8 pr-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700 focus:border-blue-500 focus:outline-none text-sm w-64"
            />
          </div>
          <div className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                  filter === f.key
                    ? "border-blue-500 bg-blue-600/20 text-blue-300"
                    : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-4 py-3 mb-4">{error}</div>
        )}

        {/* Table */}
        <div className="rounded-xl border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/80 text-zinc-400 text-xs">
              <tr>
                <th className="text-left font-medium px-3 py-2.5">Name</th>
                <th className="text-left font-medium px-3 py-2.5">Email</th>
                {SORTS.filter((s) => s.key !== "email").map((s) => (
                  <th
                    key={s.key}
                    onClick={() => toggleSort(s.key)}
                    className="text-left font-medium px-3 py-2.5 cursor-pointer hover:text-blue-300 select-none whitespace-nowrap"
                  >
                    {s.label} {sort === s.key ? (direction === "asc" ? "▲" : "▼") : ""}
                  </th>
                ))}
                <th className="text-left font-medium px-3 py-2.5">Key</th>
                <th className="text-left font-medium px-3 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {data?.users.map((u) => (
                <tr key={u.userId} className="hover:bg-zinc-900/40">
                  <td className="px-3 py-2.5 text-zinc-200">{u.name || "—"}</td>
                  <td className="px-3 py-2.5 text-zinc-400 font-mono text-xs">{u.email}</td>
                  <td className="px-3 py-2.5 text-zinc-400">{fmt(u.signupDate)}</td>
                  <td className="px-3 py-2.5 text-zinc-400">{fmt(u.lastLoginAt)}</td>
                  <td className="px-3 py-2.5 text-zinc-400">{u.loginCount}</td>
                  <td className="px-3 py-2.5 text-zinc-400">{u.agentCount}</td>
                  <td className="px-3 py-2.5 text-zinc-400">{u.taskCount}</td>
                  <td className="px-3 py-2.5">
                    {u.developerKeyCreated ? (
                      <CheckCircle2 className="h-4 w-4 text-green-400" />
                    ) : (
                      <XCircle className="h-4 w-4 text-zinc-700" />
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {u.activated ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-900/40 text-green-300 border border-green-800">
                        Activated
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 border border-zinc-700">
                        Signed up
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {data && data.users.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-zinc-600 text-sm">
                    No users match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <p className="text-xs text-zinc-600 mt-3">Loading…</p>}
      </div>
    </div>
  );
}
