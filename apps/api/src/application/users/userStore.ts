/**
 * User lifecycle store — upsert-on-Google-login, login bookkeeping, onboarding
 * funnel state, and tenant linkage.
 *
 * This is the human-identity counterpart to the api_keys/tenants machinery. It
 * owns the `users` and `user_onboarding` tables (migration 0033) and nothing
 * else; analytics events are recorded separately via userEvents.ts and founder
 * aggregates are computed in founderMetrics.ts, so this module stays a thin,
 * well-typed data-access layer.
 */

import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";
import type { GoogleIdentity } from "../../infrastructure/security/googleAuth.js";
import { createId } from "../../shared/id.js";

export interface UserRecord {
  id: string;
  google_id: string;
  email: string;
  name: string | null;
  profile_picture: string | null;
  tenant_id: string | null;
  is_founder: boolean;
  created_at: string;
  last_login_at: string | null;
  login_count: number;
}

export interface OnboardingState {
  user_id: string;
  onboarding_started: string | null;
  onboarding_completed: string | null;
  developer_key_created: string | null;
  first_agent_created: string | null;
  first_task_executed: string | null;
  first_replay_viewed: string | null;
  updated_at: string;
}

/** The four onboarding milestones the user actively completes (step 2..5). */
export type OnboardingStep =
  | "developer_key_created"
  | "first_agent_created"
  | "first_task_executed"
  | "first_replay_viewed";

const ONBOARDING_STEP_COLUMNS: Record<OnboardingStep, string> = {
  // Whitelist mapping step → physical column. NEVER interpolate a caller-supplied
  // value into SQL; the column name only ever comes from this fixed table.
  developer_key_created: "developer_key_created",
  first_agent_created: "first_agent_created",
  first_task_executed: "first_task_executed",
  first_replay_viewed: "first_replay_viewed"
};

/**
 * Upsert a user from a verified Google identity and record the login.
 *
 *   • New user  → insert with login_count = 1, last_login_at = now().
 *   • Returning → update last_login_at, login_count = login_count + 1, and
 *     refresh name/picture (Google is the source of truth) + is_founder.
 *
 * `inserted` (Postgres' xmax = 0 trick on the conflict path) distinguishes a
 * brand-new signup from a returning login so the caller can fire the right
 * analytics event and route first-time users into onboarding.
 */
export async function upsertUserFromGoogle(
  db: PgClient,
  identity: GoogleIdentity,
  isFounder: boolean
): Promise<{ user: UserRecord; isNewUser: boolean }> {
  const id = createId();
  const { rows } = await db.query<UserRecord & { inserted: boolean }>(
    `insert into users
       (id, google_id, email, name, profile_picture, is_founder,
        created_at, last_login_at, login_count)
     values ($1, $2, $3, $4, $5, $6, now(), now(), 1)
     on conflict (google_id) do update
       set email           = excluded.email,
           name            = coalesce(excluded.name, users.name),
           profile_picture = coalesce(excluded.profile_picture, users.profile_picture),
           is_founder      = excluded.is_founder,
           last_login_at   = now(),
           login_count     = users.login_count + 1
     returning *, (xmax = 0) as inserted`,
    [id, identity.googleId, identity.email, identity.name, identity.picture, isFounder]
  );
  const row = rows[0]!;
  const { inserted, ...user } = row;
  return { user: user as UserRecord, isNewUser: inserted };
}

export async function getUserById(db: PgClient, userId: string): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRecord>("select * from users where id = $1", [userId]);
  return rows[0] ?? null;
}

/** Link a freshly-minted tenant to a user (set once, on first key creation). */
export async function linkUserTenant(db: PgClient, userId: string, tenantId: string): Promise<void> {
  await db.query("update users set tenant_id = $1 where id = $2", [tenantId, userId]);
}

/**
 * Fetch (creating if absent) the onboarding row for a user, stamping
 * onboarding_started on first read — the moment a user lands in the flow.
 */
export async function ensureOnboarding(db: PgClient, userId: string): Promise<OnboardingState> {
  const { rows } = await db.query<OnboardingState>(
    `insert into user_onboarding (user_id, onboarding_started, updated_at)
     values ($1, now(), now())
     on conflict (user_id) do update set updated_at = user_onboarding.updated_at
     returning *`,
    [userId]
  );
  return rows[0]!;
}

/**
 * Mark an onboarding milestone complete (idempotent — only stamps a column that
 * is still NULL, preserving the first-completion timestamp). When all four
 * milestones are present, stamps onboarding_completed too. Returns the new state.
 */
export async function markOnboardingStep(
  db: PgClient,
  userId: string,
  step: OnboardingStep
): Promise<OnboardingState> {
  const column = ONBOARDING_STEP_COLUMNS[step];
  if (!column) throw new Error(`Unknown onboarding step: ${step}`);

  await ensureOnboarding(db, userId);
  // `coalesce(col, now())` makes the write idempotent: a repeat call leaves the
  // original timestamp untouched. The column name is from the fixed whitelist
  // above — never caller input — so the interpolation is injection-safe.
  const { rows } = await db.query<OnboardingState>(
    `update user_onboarding
        set ${column} = coalesce(${column}, now()),
            onboarding_completed = case
              when onboarding_completed is not null then onboarding_completed
              when coalesce(developer_key_created, case when $2 = 'developer_key_created' then now() end) is not null
               and coalesce(first_agent_created,   case when $2 = 'first_agent_created'   then now() end) is not null
               and coalesce(first_task_executed,   case when $2 = 'first_task_executed'   then now() end) is not null
               and coalesce(first_replay_viewed,   case when $2 = 'first_replay_viewed'   then now() end) is not null
                then now()
              else null
            end,
            updated_at = now()
      where user_id = $1
      returning *`,
    [userId, step]
  );
  return rows[0]!;
}
