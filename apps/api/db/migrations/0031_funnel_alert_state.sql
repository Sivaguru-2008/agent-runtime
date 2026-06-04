-- 0031_funnel_alert_state.sql
-- Durable state for funnel threshold alerts (Phase 2, capability 11).
--
-- Why this exists:
--   Alerts are evaluated against the funnel each time the alert endpoint is
--   read (and can be driven on a schedule by polling it). To page an operator
--   exactly ONCE per breach — not on every evaluation — the evaluator must
--   remember each rule's last known status across evaluations. This table is
--   that memory: one row per rule, carrying its current status, the value that
--   tripped it, and when it last entered/left the firing state.
--
--   Debounce contract: the evaluator only emits a transition (logs a warning /
--   would notify) when a rule's status CHANGES (ok→firing or firing→ok). A rule
--   that stays firing across many evaluations produces one transition, not N.
--
-- Empty-vs-broken distinction:
--   A rule whose inputs are simply absent (e.g. zero signups in the window, so
--   no activation-rate sample) resolves to status 'ok' with a reason, never
--   'firing' — an empty dataset is not an emergency.

create table if not exists funnel_alert_state (
  -- Stable rule identifier, e.g. 'low_activation_rate' | 'signup_gap'.
  rule_id      text        primary key,
  -- 'ok' | 'firing'.
  status       text        not null,
  -- The measured value that produced `status` (rate, hours since last signup…).
  last_value   double precision null,
  -- The threshold in force at evaluation time (for forensic comparison).
  threshold    double precision null,
  -- Free-form structured context (sample size, window, human reason).
  detail       jsonb       not null default '{}'::jsonb,
  -- When the rule most recently ENTERED the firing state (null while ok).
  fired_at     timestamptz null,
  -- When the rule most recently RETURNED to ok (null while firing).
  recovered_at timestamptz null,
  -- Last evaluation timestamp (always advances).
  updated_at   timestamptz not null default now()
);
