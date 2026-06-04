-- 0028_self_serve_signups.sql
-- Self-serve onboarding funnel.
--
-- Why this exists:
--   Until now the ONLY way to obtain an API key was an operator running
--   scripts/seed-owner-key.mjs or POST /admin/api-keys (admin-gated). That made
--   self-service impossible: every new developer required a human in the loop.
--   POST /signup closes that gap by minting a least-privilege `developer` key
--   against a fresh tenant. This table is the durable record of who signed up —
--   the founder's lead list AND the base of the activation funnel (signed up →
--   ran first agent → retained).
--
-- Privacy/security:
--   • We persist the email (lead follow-up) and the invite code used (attribution)
--     but NEVER the raw API key — only a pointer to the api_keys row it minted.
--   • email is unique: a repeat signup with the same email is a conflict, not a
--     silent duplicate tenant (the route turns this into an idempotent 409).

create table if not exists signups (
  id           text primary key,
  email        text not null,
  tenant_id    text not null references tenants(id) on delete cascade,
  api_key_id   text not null references api_keys(id) on delete cascade,
  invite_code  text null,
  source       text null,            -- utm/source attribution (e.g. 'landing', 'docs')
  created_at   timestamptz not null default now(),
  -- Activation marker: set when this tenant runs its first traced task. Lets us
  -- compute signup→activation conversion without scanning the executions table.
  activated_at timestamptz null
);

-- Case-insensitive email uniqueness so 'Ada@x.com' and 'ada@x.com' collide.
create unique index if not exists idx_signups_email_lower on signups (lower(email));
create index if not exists idx_signups_created_at on signups (created_at desc);
create index if not exists idx_signups_tenant on signups (tenant_id);
