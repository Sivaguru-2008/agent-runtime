/**
 * Founder analytics — the read side of the human-identity tables.
 *
 * Pure query functions over users / user_events / user_onboarding (+ the
 * tenant-scoped agents/executions tables for per-user counts). Each returns a
 * fully-typed, JSON-serializable shape the founder dashboard renders directly.
 * No mutation, no side effects — every founder route is a thin wrapper around
 * one of these.
 *
 * Activation model (so the numbers are unambiguous):
 *   visitors  → distinct landing-page visits (user_events 'visit')
 *   signups   → users rows (a Google account that logged in at least once)
 *   logins    → users with login_count > 0  (everyone who completed auth)
 *   activation milestones, in order:
 *       developer key created → first agent created → first task executed →
 *       first replay viewed
 *   A user is "activated" once they have executed their first task.
 *   retention → users who logged in more than once (login_count > 1).
 */

import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function toInt(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function ratio(num: number, den: number): number {
  return den > 0 ? num / den : 0;
}

// ── Overview ────────────────────────────────────────────────────────────────

export interface FounderOverview {
  totalUsers: number;
  newUsersToday: number;
  newUsersThisWeek: number;
  totalLogins: number;
  activeUsers24h: number;
  activeUsers7d: number;
  activeUsers30d: number;
  activation: {
    developerKeysCreated: number;
    agentsCreated: number;
    tasksExecuted: number;
    replaysViewed: number;
  };
  recentActivity: ActivityEntry[];
}

export interface ActivityEntry {
  eventType: string;
  occurredAt: string;
  userId: string | null;
  email: string | null;
  name: string | null;
}

export async function founderOverview(db: PgClient): Promise<FounderOverview> {
  // One round-trip for the user/onboarding scalar block.
  const { rows: scalar } = await db.query<Record<string, string>>(
    `select
       (select count(*) from users)                                                       as total_users,
       (select count(*) from users where created_at >= date_trunc('day', now()))          as new_today,
       (select count(*) from users where created_at >= now() - interval '7 days')         as new_week,
       (select coalesce(sum(login_count), 0) from users)                                  as total_logins,
       (select count(*) from user_onboarding where developer_key_created is not null)     as dev_keys,
       (select count(*) from user_onboarding where first_agent_created   is not null)     as agents,
       (select count(*) from user_onboarding where first_task_executed   is not null)     as tasks,
       (select count(*) from user_onboarding where first_replay_viewed   is not null)     as replays`
  );
  const s = scalar[0] ?? {};

  // Active users = distinct users with any (identified) product event in window.
  const { rows: active } = await db.query<{ window: string; users: string }>(
    `select w.window, count(distinct e.user_id) as users
       from (values ('24h', interval '1 day'), ('7d', interval '7 days'), ('30d', interval '30 days')) as w(window, span)
       left join user_events e
         on e.user_id is not null and e.occurred_at >= now() - w.span
      group by w.window`
  );
  const activeByWindow = new Map(active.map((r) => [r.window, toInt(r.users)]));

  const { rows: feed } = await db.query<{
    event_type: string;
    occurred_at: string;
    user_id: string | null;
    email: string | null;
    name: string | null;
  }>(
    `select e.event_type, e.occurred_at, e.user_id, u.email, u.name
       from user_events e
       left join users u on u.id = e.user_id
      order by e.occurred_at desc
      limit 25`
  );

  return {
    totalUsers: toInt(s.total_users),
    newUsersToday: toInt(s.new_today),
    newUsersThisWeek: toInt(s.new_week),
    totalLogins: toInt(s.total_logins),
    activeUsers24h: activeByWindow.get("24h") ?? 0,
    activeUsers7d: activeByWindow.get("7d") ?? 0,
    activeUsers30d: activeByWindow.get("30d") ?? 0,
    activation: {
      developerKeysCreated: toInt(s.dev_keys),
      agentsCreated: toInt(s.agents),
      tasksExecuted: toInt(s.tasks),
      replaysViewed: toInt(s.replays)
    },
    recentActivity: feed.map((r) => ({
      eventType: r.event_type,
      occurredAt: r.occurred_at,
      userId: r.user_id,
      email: r.email,
      name: r.name
    }))
  };
}

// ── Activation funnel ─────────────────────────────────────────────────────────

export interface FunnelStage {
  stage: string;
  count: number;
  /** Conversion from the previous stage (0..1). */
  stepConversion: number;
  /** Conversion from the top of the funnel / visitors (0..1). */
  overallConversion: number;
}

export interface ActivationFunnel {
  stages: FunnelStage[];
  signupRate: number; // signups / visitors
  activationRate: number; // activated (task executed) / signups
  retentionRate: number; // returning (login_count>1) / signups
  /** The largest drop between consecutive stages — where users are lost. */
  biggestDropOff: { from: string; to: string; lostPct: number } | null;
}

export async function activationFunnel(db: PgClient): Promise<ActivationFunnel> {
  const { rows } = await db.query<Record<string, string>>(
    `select
       (select count(*) from user_events where event_type = 'visit')                  as visitors,
       (select count(*) from users)                                                   as signups,
       (select count(*) from users where login_count > 0)                             as logins,
       (select count(*) from users where login_count > 1)                             as returning,
       (select count(*) from user_onboarding where developer_key_created is not null) as dev_keys,
       (select count(*) from user_onboarding where first_agent_created   is not null) as agents,
       (select count(*) from user_onboarding where first_task_executed   is not null) as tasks,
       (select count(*) from user_onboarding where first_replay_viewed   is not null) as replays`
  );
  const r = rows[0] ?? {};
  const counts: Array<{ stage: string; count: number }> = [
    { stage: "Visitors", count: toInt(r.visitors) },
    { stage: "Signups", count: toInt(r.signups) },
    { stage: "Logins", count: toInt(r.logins) },
    { stage: "Developer Keys", count: toInt(r.dev_keys) },
    { stage: "Agents Created", count: toInt(r.agents) },
    { stage: "Tasks Executed", count: toInt(r.tasks) },
    { stage: "Replays Viewed", count: toInt(r.replays) }
  ];
  const top = counts[0]!.count;
  const stages: FunnelStage[] = counts.map((c, i) => {
    const prev = i === 0 ? c.count : counts[i - 1]!.count;
    return {
      stage: c.stage,
      count: c.count,
      stepConversion: i === 0 ? 1 : ratio(c.count, prev),
      overallConversion: ratio(c.count, top)
    };
  });

  // Biggest absolute drop in step-conversion between consecutive non-empty stages.
  let biggestDropOff: ActivationFunnel["biggestDropOff"] = null;
  for (let i = 1; i < counts.length; i++) {
    const prev = counts[i - 1]!;
    const cur = counts[i]!;
    if (prev.count <= 0) continue;
    const lost = 1 - ratio(cur.count, prev.count);
    if (!biggestDropOff || lost > biggestDropOff.lostPct) {
      biggestDropOff = { from: prev.stage, to: cur.stage, lostPct: lost };
    }
  }

  const visitors = toInt(r.visitors);
  const signups = toInt(r.signups);
  return {
    stages,
    signupRate: ratio(signups, visitors),
    activationRate: ratio(toInt(r.tasks), signups),
    retentionRate: ratio(toInt(r.returning), signups),
    biggestDropOff
  };
}

// ── Operational insight ────────────────────────────────────────────────────────

export interface FounderInsights {
  dau: number;
  wau: number;
  mau: number;
  activationRate: number;
  avgTasksPerUser: number;
  avgAgentsPerUser: number;
  topUsers: UserUsage[];
  recentlyActive: UserUsage[];
  signedUpNeverActivated: UserUsage[];
  activatedNeverReturned: UserUsage[];
}

export interface UserUsage {
  userId: string;
  email: string;
  name: string | null;
  loginCount: number;
  lastLoginAt: string | null;
  agentCount: number;
  taskCount: number;
  activated: boolean;
}

export async function founderInsights(db: PgClient): Promise<FounderInsights> {
  // Per-user usage joined to the tenant-scoped agents/executions counts. A user
  // with no linked tenant (no key yet) gets zero counts. LEFT JOIN LATERAL keeps
  // it one round-trip and avoids fanning out the row per agent/execution.
  const { rows } = await db.query<{
    user_id: string;
    email: string;
    name: string | null;
    login_count: string;
    last_login_at: string | null;
    agent_count: string;
    task_count: string;
    first_task_executed: string | null;
  }>(
    `select u.id as user_id, u.email, u.name, u.login_count, u.last_login_at,
            coalesce(ac.n, 0) as agent_count,
            coalesce(ec.n, 0) as task_count,
            ob.first_task_executed
       from users u
       left join user_onboarding ob on ob.user_id = u.id
       left join lateral (
         select count(*) as n from agents a where u.tenant_id is not null and a.tenant_id = u.tenant_id
       ) ac on true
       left join lateral (
         select count(*) as n from executions e where u.tenant_id is not null and e.tenant_id = u.tenant_id
       ) ec on true`
  );

  const users: UserUsage[] = rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    name: r.name,
    loginCount: toInt(r.login_count),
    lastLoginAt: r.last_login_at,
    agentCount: toInt(r.agent_count),
    taskCount: toInt(r.task_count),
    activated: r.first_task_executed != null
  }));

  // Active-user windows from the event stream (distinct identified users).
  const { rows: au } = await db.query<{ window: string; users: string }>(
    `select w.window, count(distinct e.user_id) as users
       from (values ('dau', interval '1 day'), ('wau', interval '7 days'), ('mau', interval '30 days')) as w(window, span)
       left join user_events e
         on e.user_id is not null and e.occurred_at >= now() - w.span
      group by w.window`
  );
  const auMap = new Map(au.map((r) => [r.window, toInt(r.users)]));

  const totalUsers = users.length;
  const activatedUsers = users.filter((u) => u.activated).length;
  const totalTasks = users.reduce((acc, u) => acc + u.taskCount, 0);
  const totalAgents = users.reduce((acc, u) => acc + u.agentCount, 0);
  const now = Date.now();
  const ageMs = (iso: string | null): number => (iso ? now - new Date(iso).getTime() : Infinity);

  const byTasks = [...users].sort((a, b) => b.taskCount - a.taskCount || b.agentCount - a.agentCount);
  const byRecent = [...users].sort((a, b) => ageMs(a.lastLoginAt) - ageMs(b.lastLoginAt));

  return {
    dau: auMap.get("dau") ?? 0,
    wau: auMap.get("wau") ?? 0,
    mau: auMap.get("mau") ?? 0,
    activationRate: ratio(activatedUsers, totalUsers),
    avgTasksPerUser: totalUsers > 0 ? totalTasks / totalUsers : 0,
    avgAgentsPerUser: totalUsers > 0 ? totalAgents / totalUsers : 0,
    topUsers: byTasks.slice(0, 10),
    recentlyActive: byRecent.filter((u) => u.lastLoginAt).slice(0, 10),
    // Signed up but never ran a task.
    signedUpNeverActivated: users.filter((u) => !u.activated).slice(0, 50),
    // Activated (ran a task) but only ever logged in once → never came back.
    activatedNeverReturned: users
      .filter((u) => u.activated && u.loginCount <= 1 && ageMs(u.lastLoginAt) > 7 * DAY_MS)
      .slice(0, 50)
  };
}

// ── User directory ──────────────────────────────────────────────────────────

export type UserSortKey =
  | "created_at"
  | "last_login_at"
  | "login_count"
  | "email"
  | "agent_count"
  | "task_count";

export interface UserDirectoryQuery {
  search?: string;
  /** "all" | "activated" | "not_activated" | "has_key". */
  filter?: string;
  sort?: UserSortKey;
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface DirectoryUser {
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

export interface UserDirectoryResult {
  users: DirectoryUser[];
  total: number;
  limit: number;
  offset: number;
}

const SORT_COLUMNS: Record<UserSortKey, string> = {
  created_at: "u.created_at",
  last_login_at: "u.last_login_at",
  login_count: "u.login_count",
  email: "lower(u.email)",
  agent_count: "agent_count",
  task_count: "task_count"
};

export async function userDirectory(
  db: PgClient,
  q: UserDirectoryQuery
): Promise<UserDirectoryResult> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  const sortCol = SORT_COLUMNS[q.sort ?? "created_at"] ?? SORT_COLUMNS.created_at;
  const direction = q.direction === "asc" ? "asc" : "desc";

  const where: string[] = [];
  const params: unknown[] = [];
  if (q.search && q.search.trim()) {
    params.push(`%${q.search.trim().toLowerCase()}%`);
    where.push(`(lower(u.email) like $${params.length} or lower(coalesce(u.name, '')) like $${params.length})`);
  }
  switch (q.filter) {
    case "activated":
      where.push("ob.first_task_executed is not null");
      break;
    case "not_activated":
      where.push("ob.first_task_executed is null");
      break;
    case "has_key":
      where.push("ob.developer_key_created is not null");
      break;
    default:
      break;
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";

  // Count (filtered) for pagination.
  const { rows: countRows } = await db.query<{ n: string }>(
    `select count(*) as n
       from users u
       left join user_onboarding ob on ob.user_id = u.id
       ${whereSql}`,
    params
  );
  const total = toInt(countRows[0]?.n);

  const pageParams = [...params, limit, offset];
  const { rows } = await db.query<{
    user_id: string;
    name: string | null;
    email: string;
    created_at: string;
    last_login_at: string | null;
    login_count: string;
    developer_key_created: string | null;
    first_task_executed: string | null;
    agent_count: string;
    task_count: string;
  }>(
    `select u.id as user_id, u.name, u.email, u.created_at, u.last_login_at, u.login_count,
            ob.developer_key_created, ob.first_task_executed,
            coalesce(ac.n, 0) as agent_count,
            coalesce(ec.n, 0) as task_count
       from users u
       left join user_onboarding ob on ob.user_id = u.id
       left join lateral (
         select count(*) as n from agents a where u.tenant_id is not null and a.tenant_id = u.tenant_id
       ) ac on true
       left join lateral (
         select count(*) as n from executions e where u.tenant_id is not null and e.tenant_id = u.tenant_id
       ) ec on true
       ${whereSql}
      order by ${sortCol} ${direction} nulls last
      limit $${pageParams.length - 1} offset $${pageParams.length}`,
    pageParams
  );

  return {
    total,
    limit,
    offset,
    users: rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      email: r.email,
      signupDate: r.created_at,
      lastLoginAt: r.last_login_at,
      loginCount: toInt(r.login_count),
      developerKeyCreated: r.developer_key_created != null,
      agentCount: toInt(r.agent_count),
      taskCount: toInt(r.task_count),
      activated: r.first_task_executed != null
    }))
  };
}
