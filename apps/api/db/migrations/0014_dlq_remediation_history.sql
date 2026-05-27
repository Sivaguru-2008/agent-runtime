-- 0014_dlq_remediation_history.sql
begin;

create table if not exists dlq_remediation_actions (
  id uuid primary key,
  execution_id text not null,
  action text not null,
  operator_identity text not null default 'system',
  prior_resolution_state text null,
  new_resolution_state text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_dlq_remediation_execution
  on dlq_remediation_actions(execution_id);

comment on table dlq_remediation_actions is 'Append-only audit trail for DLQ manual and automated remediation actions.';

commit;
