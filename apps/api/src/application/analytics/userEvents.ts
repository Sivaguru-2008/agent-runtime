/**
 * Product-analytics event recording — the write side of `user_events`
 * (migration 0033). The human-identity analog of funnelEvents.ts.
 *
 * Every product-relevant thing a human does — visits, signs up, logs in/out,
 * mints a key, creates an agent, runs/finishes a task, views a replay — is
 * recorded here as an immutable, timestamped event. The founder dashboard and
 * activation funnel derive purely from this stream + the users table.
 *
 * Same two hard invariants as funnelEvents:
 *   1. FAIL-SAFE — recording never throws, rejects, delays, or fails the caller.
 *      A null db (MEMORY mode) is a clean no-op.
 *   2. IDEMPOTENT — each event carries a deterministic dedupe_key; the insert is
 *      `on conflict (dedupe_key) do nothing`. Milestone events (signup, each
 *      first_* step, onboarding_completed) use a stable per-user key so they
 *      record at most once; repeatable events (login/logout/visit) pass a unique
 *      key (default: a fresh id) so they accumulate.
 */

import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";
import { createId } from "../../shared/id.js";

export type UserEventType =
  | "visit"
  | "signup"
  | "login"
  | "logout"
  | "developer_key_created"
  | "agent_created"
  | "task_started"
  | "task_completed"
  | "replay_viewed"
  | "onboarding_started"
  | "onboarding_completed";

export interface RecordUserEventInput {
  userId: string | null;
  eventType: UserEventType;
  /**
   * Deterministic idempotency key. Omit for repeatable events (login/logout/
   * visit) — a fresh unique id is used so every occurrence is recorded. Provide
   * a stable key for milestone events so they record at most once.
   */
  dedupeKey?: string;
  occurredAt?: Date | null;
  properties?: Record<string, unknown>;
}

/**
 * Deterministic dedupe-key builders for the once-only milestone events. One per
 * user; namespaced by event type so keyspaces never collide.
 */
export const userEventDedupe = {
  signup: (userId: string): string => `user-signup:${userId}`,
  onboardingStarted: (userId: string): string => `onboarding-started:${userId}`,
  onboardingCompleted: (userId: string): string => `onboarding-completed:${userId}`,
  developerKeyCreated: (userId: string): string => `developer-key:${userId}`,
  firstAgent: (userId: string): string => `first-agent:${userId}`,
  firstTask: (userId: string): string => `first-task:${userId}`,
  firstReplay: (userId: string): string => `first-replay:${userId}`
};

/**
 * Record a product-analytics event. Fire-and-forget: returns void immediately,
 * never throws, never rejects (mirrors recordFunnelEvent). A null db is a no-op.
 */
export function recordUserEvent(db: PgClient | null, input: RecordUserEventInput): void {
  if (!db) return;
  try {
    void db
      .query(
        `insert into user_events
           (id, user_id, event_type, occurred_at, dedupe_key, properties)
         values ($1, $2, $3, coalesce($4, now()), $5, $6::jsonb)
         on conflict (dedupe_key) do nothing`,
        [
          createId(),
          input.userId,
          input.eventType,
          input.occurredAt ?? null,
          input.dedupeKey ?? createId(),
          JSON.stringify(input.properties ?? {})
        ]
      )
      .catch(() => undefined);
  } catch {
    // Synchronous throw from db.query — analytics bookkeeping must never disturb
    // the observed request. Intentionally swallowed (mirrors recordFunnelEvent).
  }
}
