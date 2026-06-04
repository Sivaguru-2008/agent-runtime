/**
 * Funnel event recording + source attribution normalization.
 *
 * This is the write side of the append-only funnel event log (migration
 * 0029_funnel_events). Every funnel-relevant thing that happens — a self-serve
 * signup, a tenant's first traced task (activation) — is recorded here as an
 * immutable, time-stamped, deduplicated event. Historical / cohort / trend
 * analytics derive purely from this stream.
 *
 * Two hard invariants this module upholds:
 *   1. FAIL-SAFE. Recording an event must NEVER throw, reject, delay, or fail
 *      the caller. Analytics bookkeeping is strictly subordinate to the request
 *      it observes — exactly the contract of markTenantActivated. A null db
 *      (MEMORY mode) is a clean no-op; a synchronous throw or async rejection
 *      from db.query is swallowed.
 *   2. IDEMPOTENT. Each event carries a deterministic `dedupe_key`. The insert
 *      is `on conflict (dedupe_key) do nothing`, so retries, double-fires and
 *      a re-run of the backfill never double-count. This also keeps the cohort
 *      join (signup ⋈ activation on tenant) strictly 1:≤1.
 */

import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";
import { createId } from "../../shared/id.js";

/** Funnel step kinds recorded today. The column is free-text so further step
 *  types need no migration to start flowing. */
export type FunnelEventType = "signup" | "activation" | "retention_ping";

/** First-touch attribution carried on an event. All fields optional/nullable. */
export interface FunnelAttribution {
  /** Normalized source slug — pass the output of normalizeSource(). */
  source?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  referrer?: string | null;
  landingPath?: string | null;
}

export interface RecordFunnelEventInput {
  tenantId: string;
  eventType: FunnelEventType;
  /** Deterministic idempotency key — build via {@link funnelDedupe}. */
  dedupeKey: string;
  /** When the modelled thing happened. Defaults to now() in SQL when omitted. */
  occurredAt?: Date | null;
  attribution?: FunnelAttribution;
  properties?: Record<string, unknown>;
}

/**
 * Deterministic dedupe-key builders. One signup and one activation per tenant
 * are the only Phase-1 events, so the tenant id uniquely identifies each.
 * Namespaced by event type so the keyspaces never collide.
 */
export const funnelDedupe = {
  signup: (tenantId: string): string => `signup:${tenantId}`,
  activation: (tenantId: string): string => `activation:${tenantId}`,
  /**
   * Retention pings are debounced to one per tenant per UTC day: the day stamp
   * in the key collapses a burst of tasks into a single durable "active today"
   * event via the on-conflict insert. `day` defaults to today (UTC).
   */
  retention: (tenantId: string, day: string = new Date().toISOString().slice(0, 10)): string =>
    `retention:${tenantId}:${day}`
};

/**
 * Record a daily retention ping for a tenant — fire-and-forget, daily-debounced.
 * Called from the task handler on every traced task; the dedupe key collapses
 * same-day calls to one row so the write volume is one insert/tenant/day. This
 * is the raw signal the retention curve is built from. Fail-safe like
 * {@link recordFunnelEvent}.
 */
export function recordRetentionPing(db: PgClient | null, tenantId: string): void {
  recordFunnelEvent(db, {
    tenantId,
    eventType: "retention_ping",
    dedupeKey: funnelDedupe.retention(tenantId)
  });
}

/**
 * Common source aliases collapsed to a canonical slug. Intentionally small and
 * conservative — it only folds well-known short forms. Anything not listed is
 * kept as its own normalized slug (never black-holed), so granularity is
 * preserved and no attribution is ever dropped.
 */
const SOURCE_ALIASES: Record<string, string> = {
  tw: "twitter",
  x: "twitter",
  gh: "github",
  hn: "hackernews",
  "hacker-news": "hackernews",
  yc: "ycombinator",
  ph: "producthunt",
  "product-hunt": "producthunt",
  li: "linkedin",
  doc: "docs",
  documentation: "docs"
};

/**
 * Normalize a raw, user/client-supplied source string into a stable bucket.
 *
 *   • trim + lowercase + slugify  → "Twitter", "twitter ", "TWITTER" all
 *     collapse to "twitter".
 *   • alias map                   → "tw" / "x" → "twitter", "gh" → "github".
 *   • empty / null / whitespace   → "direct" (the canonical "no attribution").
 *
 * Unknown sources are returned as their own slug (e.g. "newsletter-q2"), NOT
 * folded into a catch-all, so legitimate new channels are never lost.
 */
export function normalizeSource(raw: string | null | undefined): string {
  if (raw == null) return "direct";
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  if (!slug) return "direct";
  return SOURCE_ALIASES[slug] ?? slug;
}

/**
 * Record a funnel event. Fire-and-forget: returns void immediately, never
 * throws, never rejects. See the module header for the fail-safe / idempotent
 * contract. A null db (MEMORY fallback, no security store) is a no-op.
 */
export function recordFunnelEvent(db: PgClient | null, input: RecordFunnelEventInput): void {
  if (!db) return;
  const attr = input.attribution ?? {};
  try {
    void db
      .query(
        `insert into funnel_events
           (id, tenant_id, event_type, occurred_at,
            source, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            referrer, landing_path, dedupe_key, properties)
         values
           ($1, $2, $3, coalesce($4, now()),
            $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14::jsonb)
         on conflict (dedupe_key) do nothing`,
        [
          createId(),
          input.tenantId,
          input.eventType,
          input.occurredAt ?? null,
          attr.source ?? null,
          attr.utmSource ?? null,
          attr.utmMedium ?? null,
          attr.utmCampaign ?? null,
          attr.utmTerm ?? null,
          attr.utmContent ?? null,
          attr.referrer ?? null,
          attr.landingPath ?? null,
          input.dedupeKey,
          JSON.stringify(input.properties ?? {})
        ]
      )
      .catch(() => undefined);
  } catch {
    // Synchronous throw from db.query — funnel bookkeeping must never disturb
    // the observed request. Intentionally swallowed (mirrors markTenantActivated).
  }
}
