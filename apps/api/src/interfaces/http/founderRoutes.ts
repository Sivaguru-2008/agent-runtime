/**
 * Founder admin dashboard + user directory routes.
 *
 * These expose the human-identity analytics (overview, activation funnel,
 * operational insight, user directory) and are gated by the SAME session guard
 * as /auth, requiring is_founder. They live under "/admin/founder" which app.ts
 * adds to the auth skip-paths so the API-key plugin ignores them — founder
 * access is a HUMAN session (Google login), not a machine key.
 *
 * Defense in depth:
 *   • The guard returns 401 (no/invalid session) or 403 (valid session, not a
 *     founder) — never silently allows.
 *   • Read-only: every handler is a pure aggregate query. No mutation surface.
 *
 * Routes:
 *   GET /admin/founder/overview     — totals, new users, logins, active users,
 *                                     activation metrics, recent activity feed.
 *   GET /admin/founder/funnel       — the activation/conversion funnel + rates.
 *   GET /admin/founder/insights     — DAU/WAU/MAU, averages, top/at-risk users.
 *   GET /admin/founder/users        — searchable/sortable/filterable directory.
 */

import type { FastifyInstance } from "fastify";
import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";
import { createSessionGuard, type SessionGuardOptions } from "./sessionAuth.js";
import {
  founderOverview,
  activationFunnel,
  founderInsights,
  userDirectory,
  type UserSortKey
} from "../../application/analytics/founderMetrics.js";

const VALID_SORTS: UserSortKey[] = [
  "created_at",
  "last_login_at",
  "login_count",
  "email",
  "agent_count",
  "task_count"
];

export async function registerFounderRoutes(
  app: FastifyInstance,
  db: PgClient | null,
  options: SessionGuardOptions
): Promise<void> {
  const authenticate = createSessionGuard(db, options);

  app.get("/admin/founder/overview", async (request, reply) => {
    const user = await authenticate(request, reply, { requireFounder: true });
    if (!user) return;
    return reply.send(await founderOverview(db!));
  });

  app.get("/admin/founder/funnel", async (request, reply) => {
    const user = await authenticate(request, reply, { requireFounder: true });
    if (!user) return;
    return reply.send(await activationFunnel(db!));
  });

  app.get("/admin/founder/insights", async (request, reply) => {
    const user = await authenticate(request, reply, { requireFounder: true });
    if (!user) return;
    return reply.send(await founderInsights(db!));
  });

  app.get("/admin/founder/users", async (request, reply) => {
    const user = await authenticate(request, reply, { requireFounder: true });
    if (!user) return;

    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const sort = VALID_SORTS.includes(q.sort as UserSortKey) ? (q.sort as UserSortKey) : "created_at";
    const limit = q.limit ? Number(q.limit) : 50;
    const offset = q.offset ? Number(q.offset) : 0;

    return reply.send(
      await userDirectory(db!, {
        search: q.search,
        filter: q.filter,
        sort,
        direction: q.direction === "asc" ? "asc" : "desc",
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0
      })
    );
  });
}
