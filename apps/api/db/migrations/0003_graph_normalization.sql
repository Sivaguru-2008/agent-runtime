-- 0003_graph_normalization.sql
-- Normalized graph schema: cognition handoffs table, nullable graph column in cognition_graphs
--
begin;

-- Create cognition_handoffs table
create table if not exists cognition_handoffs (
  cognition_id text not null references cognition_graphs(id) on delete cascade,
  from_node_id text not null,
  to_role text not null,
  reason text not null,
  carry_over jsonb not null,
  primary key (cognition_id, from_node_id, to_role)
);

create index if not exists idx_cognition_handoffs_cognition on cognition_handoffs(cognition_id);

-- Make graph column in cognition_graphs nullable for deprecation
alter table cognition_graphs alter column graph drop not null;

-- Backfill historical handoffs from cognition_graphs.graph JSONB into cognition_handoffs
do $$
declare
  r record;
  h jsonb;
begin
  for r in select id, graph from cognition_graphs where graph is not null loop
    for h in select jsonb_array_elements(r.graph->'handoffs') loop
      insert into cognition_handoffs (cognition_id, from_node_id, to_role, reason, carry_over)
      values (
        r.id,
        h->>'fromNodeId',
        h->>'toRole',
        coalesce(h->>'reason', 'phase-transition'),
        coalesce(h->'carryOver', '{}'::jsonb)
      )
      on conflict (cognition_id, from_node_id, to_role) do nothing;
    end loop;
  end loop;
end;
$$;

commit;
