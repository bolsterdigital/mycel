-- Mutable run barrier plus per-phase receipts (ADR 028). Rejected: committing a content write
-- before its receipt, which cannot distinguish a lost response from an unexecuted effect.
create table content_bulk_runs (
  tenant_id uuid not null,
  plan_id uuid not null,
  undo_requested boolean not null default false,
  primary key (tenant_id, plan_id),
  foreign key (tenant_id, plan_id) references content_bulk_plans(tenant_id, id)
);
insert into content_bulk_runs (tenant_id, plan_id)
  select tenant_id, id from content_bulk_plans;

alter table content_bulk_plan_items add unique (tenant_id, plan_id, ordinal, item_id);
create table content_bulk_effects (
  tenant_id uuid not null,
  plan_id uuid not null,
  ordinal integer not null,
  phase text not null check (phase in ('apply', 'undo')),
  item_id uuid,
  before_revision_id uuid,
  after_revision_id uuid,
  result jsonb not null,
  primary key (tenant_id, plan_id, ordinal, phase),
  foreign key (tenant_id, plan_id) references content_bulk_runs(tenant_id, plan_id),
  foreign key (tenant_id, plan_id, ordinal) references content_bulk_plan_items(tenant_id, plan_id, ordinal),
  foreign key (tenant_id, plan_id, ordinal, item_id)
    references content_bulk_plan_items(tenant_id, plan_id, ordinal, item_id),
  foreign key (tenant_id, item_id, before_revision_id)
    references content_revisions(tenant_id, item_id, id),
  foreign key (tenant_id, item_id, after_revision_id)
    references content_revisions(tenant_id, item_id, id),
  check (item_id is not null or (before_revision_id is null and after_revision_id is null))
);
alter table content_bulk_runs enable row level security;
alter table content_bulk_runs force row level security;
create policy tenant_isolation on content_bulk_runs to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
alter table content_bulk_effects enable row level security;
alter table content_bulk_effects force row level security;
create policy tenant_isolation on content_bulk_effects to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on content_bulk_runs, content_bulk_effects to mycel_app;
