/**
 * Self-serve onboarding — the public activation funnel entrypoint.
 *
 * Product risk solved:
 *   Before this route the ONLY way to obtain an API key was an operator running
 *   scripts/seed-owner-key.mjs or calling the admin-gated POST /admin/api-keys.
 *   That put a human in the loop for every single new developer — fatal for a
 *   zero-customer product trying to reach its first users. POST /signup lets a
 *   developer go from landing page to a working `developer` API key in one
 *   request, with no operator involvement.
 *
 * Safety posture (least privilege, off-by-default):
 *   • The endpoint does NOTHING unless SIGNUP_ENABLED=true. A deployment with no
 *     SIGNUP_* env set has no public credential-minting surface — identical to
 *     pre-existing behaviour.
 *   • Invite-gated by default (SIGNUP_OPEN=false): the caller must present a code
 *     from SIGNUP_INVITE_CODES. Flip SIGNUP_OPEN=true for open beta.
 *   • Mints only the `developer` role — never owner/admin/operator. The
 *     privilege-escalation guard on /admin/api-keys is therefore never bypassed.
 *   • The new tenant gets the bounded default `starter` quotas (migration 0002),
 *     so a free signup can never exhaust the cluster.
 *   • The raw key is returned exactly once and only its SHA-256 hash is stored,
 *     mirroring adminRoutes.generateApiKey.
 *
 * This route must be in the auth skip-paths (it runs unauthenticated by design).
 * app.ts appends "/signup" to skipPaths unconditionally; the SIGNUP_ENABLED gate
 * here is what actually controls availability.
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";
import { requirePermission } from "../../infrastructure/security/rbac.js";
import { createId } from "../../shared/id.js";
import {
  recordFunnelEvent,
  funnelDedupe,
  normalizeSource
} from "../../application/analytics/funnelEvents.js";
import { historicalFunnel, coerceGranularity } from "../../application/analytics/funnelQueries.js";
import { dailyFunnel } from "../../application/analytics/funnelRollup.js";

export interface SignupRouteOptions {
  enabled: boolean;
  open: boolean;
  inviteCodes: string[];
  defaultPlan: "starter" | "growth" | "enterprise";
  defaultRpm: number;
}

const signupSchema = z.object({
  email: z.string().email().max(320),
  // Human-friendly label; becomes the tenant name. Optional — derived from the
  // email local-part when omitted.
  organization: z.string().min(1).max(120).optional(),
  inviteCode: z.string().min(1).max(128).optional(),
  // Attribution for the funnel (e.g. "landing", "docs", "twitter").
  source: z.string().min(1).max(64).optional(),
  // UTM tuple — perishable acquisition attribution. Captured verbatim at signup
  // (the client lifts these off the landing URL). Each is independently optional.
  utmSource: z.string().max(128).optional(),
  utmMedium: z.string().max(128).optional(),
  utmCampaign: z.string().max(128).optional(),
  utmTerm: z.string().max(128).optional(),
  utmContent: z.string().max(128).optional(),
  // First-touch referrer / landing path. referrer falls back to the Referer
  // header when the client does not supply it.
  referrer: z.string().max(1024).optional(),
  landingPath: z.string().max(1024).optional()
});

/**
 * Activation write — the funnel's second event ("signed up" → "ran first agent").
 *
 * Called fire-and-forget from the task-creation handler when a tenant's first
 * traced task succeeds. Stamps signups.activated_at exactly once: the
 * `activated_at is null` guard makes the UPDATE idempotent (later tasks match
 * zero rows and change nothing), so we never overwrite the first-activation
 * timestamp.
 *
 * Strictly non-blocking and fail-safe — mirrors updateLastUsed in apiKeyAuth.ts.
 * It must NEVER delay or fail the execution response: a rejected promise is
 * swallowed, and a synchronous throw from db.query (which `.catch` alone would
 * miss) is caught too. A null db (in-memory / no security store) is a no-op.
 */
export function markTenantActivated(db: PgClient | null, tenantId: string): void {
  if (!db) return;
  try {
    void db
      .query(
        "update signups set activated_at = now() where tenant_id = $1 and activated_at is null",
        [tenantId]
      )
      .catch(() => undefined);
  } catch {
    // Synchronous throw from db.query — activation bookkeeping must never
    // disturb the task response. Intentionally swallowed.
  }
  // Mirror the state change into the append-only event log. recordFunnelEvent
  // is itself fully fail-safe and idempotent (dedupe_key = activation:<tenant>),
  // so a repeat call for an already-activated tenant is a harmless no-op and a
  // broken db never propagates. The signups UPDATE above remains the
  // authoritative activated_at; this is the time-series projection of it.
  recordFunnelEvent(db, {
    tenantId,
    eventType: "activation",
    dedupeKey: funnelDedupe.activation(tenantId)
  });
}

function generateApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = `sk_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawKey, "utf8").digest("hex");
  const keyPrefix = rawKey.slice(0, 16);
  return { rawKey, keyHash, keyPrefix };
}

// Build a short, slug-safe, collision-resistant tenant id from the email/org.
// Tenant ids must match /^[a-z0-9_-]+$/ (see adminRoutes.createTenantSchema).
function deriveTenantId(email: string, organization?: string): string {
  const base = (organization ?? email.split("@")[0] ?? "tenant")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "tenant";
  const suffix = randomBytes(4).toString("hex"); // 8 hex chars
  return `${base}-${suffix}`;
}

export async function registerSignupRoutes(
  app: FastifyInstance,
  db: PgClient | null,
  options: SignupRouteOptions
): Promise<void> {
  // Normalise invite codes once (trimmed, non-empty). Membership check is exact.
  const codeSet = new Set(options.inviteCodes.map((c) => c.trim()).filter(Boolean));

  app.post("/signup", async (request, reply) => {
    if (!options.enabled) {
      return reply.status(403).send({
        error: "SIGNUP_DISABLED",
        message: "Self-serve signup is not currently open. Contact the team for an invite."
      });
    }
    if (!db) {
      return reply.status(503).send({
        error: "SIGNUP_REQUIRES_DATABASE",
        message:
          "Signup requires a Postgres-backed security database. The runtime is in MEMORY fallback mode — set DATABASE_URL and restart."
      });
    }

    let body: z.infer<typeof signupSchema>;
    try {
      body = signupSchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({
        error: "INVALID_REQUEST",
        message: "A valid email is required.",
        details: err instanceof z.ZodError ? err.flatten() : undefined
      });
    }

    // Invite gate (skipped only when SIGNUP_OPEN=true).
    if (!options.open) {
      const code = body.inviteCode?.trim();
      if (!code || !codeSet.has(code)) {
        return reply.status(403).send({
          error: "INVALID_INVITE",
          message: "A valid invite code is required to sign up."
        });
      }
    }

    const email = body.email.trim();

    // Reject duplicates up front with a clear, actionable error rather than
    // minting a second tenant for the same person.
    const { rows: existing } = await db.query<{ id: string }>(
      "select id from signups where lower(email) = lower($1) limit 1",
      [email]
    );
    if (existing.length) {
      return reply.status(409).send({
        error: "EMAIL_ALREADY_REGISTERED",
        message: "An account already exists for this email. Use your existing API key or contact support to rotate it."
      });
    }

    const tenantId = deriveTenantId(email, body.organization);
    const tenantName = body.organization?.trim() || email;
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    const keyId = createId();
    const signupId = createId();

    // Attribution capture. source_norm is the normalized bucket the funnel
    // groups by; raw source is preserved for audit. Keep source_norm NULL when
    // no source was supplied (read-side coalesces to 'direct'), matching the
    // backfill convention in migration 0030. referrer falls back to the
    // Referer header when the client did not pass one.
    const sourceNorm = body.source ? normalizeSource(body.source) : null;
    const headerReferer =
      typeof request.headers.referer === "string" ? request.headers.referer : null;
    const referrer = body.referrer?.trim() || headerReferer;

    try {
      await db.withTransaction(async (tx) => {
        await tx.query(
          `insert into tenants (id, name, plan, created_at, updated_at)
           values ($1, $2, $3, now(), now())`,
          [tenantId, tenantName, options.defaultPlan]
        );
        // Default bounded quotas (migration 0002 column defaults).
        await tx.query(
          `insert into tenant_quotas (tenant_id, updated_at) values ($1, now())
           on conflict (tenant_id) do nothing`,
          [tenantId]
        );
        await tx.query(
          `insert into api_keys
             (id, tenant_id, name, key_hash, key_prefix, role, rate_limit_rpm)
           values ($1, $2, $3, $4, $5, 'developer', $6)`,
          [keyId, tenantId, "self-serve key", keyHash, keyPrefix, options.defaultRpm]
        );
        await tx.query(
          `insert into signups
             (id, email, tenant_id, api_key_id, invite_code, source, source_norm,
              utm_source, utm_medium, utm_campaign, utm_term, utm_content,
              referrer, landing_path)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            signupId, email, tenantId, keyId, body.inviteCode?.trim() ?? null,
            body.source ?? null, sourceNorm,
            body.utmSource ?? null, body.utmMedium ?? null, body.utmCampaign ?? null,
            body.utmTerm ?? null, body.utmContent ?? null,
            referrer, body.landingPath ?? null
          ]
        );
      });
    } catch (err) {
      // Unique-violation race (two concurrent signups, same email) → 409.
      const code = (err as { code?: string })?.code;
      if (code === "23505") {
        return reply.status(409).send({
          error: "EMAIL_ALREADY_REGISTERED",
          message: "An account already exists for this email."
        });
      }
      request.log.error({ err }, "[signup] failed to provision tenant");
      return reply.status(500).send({
        error: "SIGNUP_FAILED",
        message: "Could not complete signup. Please try again."
      });
    }

    request.log.info({ tenantId, keyId, source: body.source ?? null }, "[signup] new self-serve tenant provisioned");

    // Project the signup into the append-only funnel event log AFTER the
    // provisioning transaction has committed — we never want a signup event for
    // a tenant that failed to provision. recordFunnelEvent is fail-safe and
    // idempotent (dedupe_key = signup:<tenant>), so it can neither delay nor
    // fail this response. The event always carries a concrete source bucket
    // (normalizeSource maps a missing source to 'direct').
    recordFunnelEvent(db, {
      tenantId,
      eventType: "signup",
      dedupeKey: funnelDedupe.signup(tenantId),
      attribution: {
        source: normalizeSource(body.source),
        utmSource: body.utmSource ?? null,
        utmMedium: body.utmMedium ?? null,
        utmCampaign: body.utmCampaign ?? null,
        utmTerm: body.utmTerm ?? null,
        utmContent: body.utmContent ?? null,
        referrer,
        landingPath: body.landingPath ?? null
      }
    });

    // Show-once: the raw key is never recoverable after this response.
    return reply.status(201).send({
      tenantId,
      role: "developer",
      plan: options.defaultPlan,
      apiKey: rawKey,
      keyPrefix,
      rateLimitRpm: options.defaultRpm,
      createdAt: new Date().toISOString()
    });
  });

  // Founder's lead list + activation funnel. Admin-gated read of who signed up
  // and whether they activated (ran their first agent).
  app.get("/admin/signups", { preHandler: requirePermission("tenant:read") }, async () => {
    if (!db) return [];
    const { rows } = await db.query(
      `select s.id, s.email, s.tenant_id, s.invite_code, s.source,
              s.created_at, s.activated_at, t.plan
         from signups s
         join tenants t on t.id = s.tenant_id
        order by s.created_at desc
        limit 1000`
    );
    return rows;
  });

  // Activation funnel aggregates — the single number the founder watches:
  // of everyone who signed up, how many ran their first agent. One indexed
  // group-by over `signups` (idx on source helps; totals summed in-process so
  // the whole funnel is a single round-trip). Admin-gated read.
  app.get("/admin/funnel", { preHandler: requirePermission("tenant:read") }, async () => {
    const empty = { total: 0, activated: 0, activationRate: 0, bySource: [] as FunnelSource[] };
    if (!db) return empty;
    const { rows } = await db.query<{ source: string; signups: number; activated: number }>(
      `select coalesce(source_norm, 'direct') as source,
              count(*)::int as signups,
              count(activated_at)::int as activated
         from signups
        group by coalesce(source_norm, 'direct')
        order by signups desc`
    );
    let total = 0;
    let activated = 0;
    const bySource: FunnelSource[] = rows.map((r) => {
      const s = Number(r.signups);
      const a = Number(r.activated);
      total += s;
      activated += a;
      return { source: r.source, signups: s, activated: a, activationRate: s > 0 ? a / s : 0 };
    });
    return {
      total,
      activated,
      activationRate: total > 0 ? activated / total : 0,
      bySource
    };
  });

  // Historical funnel — signup→activation conversion bucketed by signup time
  // over a window, derived from the append-only funnel_events log. Answers
  // "how did conversion move week over week?" which the point-in-time funnel
  // above cannot. Admin-gated read.
  //
  //   GET /admin/funnel/history?from=ISO&to=ISO&granularity=day|week|month
  //
  // Defaults: granularity=day, to=now, from=30 days before `to`. Invalid or
  // missing dates fall back to the defaults rather than erroring, so the
  // dashboard's first paint (no params) always returns a well-formed window.
  app.get("/admin/funnel/history", { preHandler: requirePermission("tenant:read") }, async (request) => {
    const q = (request.query ?? {}) as { from?: string; to?: string; granularity?: string; source?: string };
    const granularity = coerceGranularity(q.granularity);
    const to = parseDate(q.to) ?? new Date();
    const from = parseDate(q.from) ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    // `source=rollup` serves the pre-aggregated funnel_daily table (Phase 3,
    // O(days)); the default reads the live event log (always correct, no
    // refresh dependency). Both return the identical FunnelHistory shape.
    return q.source === "rollup"
      ? dailyFunnel(db, { from, to, granularity })
      : historicalFunnel(db, { from, to, granularity });
  });
}

/** Parse an ISO date string, returning null for missing or unparseable input. */
function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface FunnelSource {
  source: string;
  signups: number;
  activated: number;
  activationRate: number;
}
