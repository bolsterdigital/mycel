-- Immutable editorial plans and their per-item dry-run results (ADR 028). Rejected: an audit
-- payload or a browser-only report, neither of which is a tenant-owned recoverable plan.
-- Retained for the lifetime of the revision archive; no cleanup job or execution grant here.
create table content_bulk_plans (
  tenant_id uuid not null references tenants(id),
  id uuid not null,
  item_count integer not null check (item_count between 1 and 100),
  version integer not null check (version = 1),
  actor jsonb not null,
  locale text not null,
  created_at timestamptz not null,
  primary key (tenant_id, id),
  unique (tenant_id, id, item_count)
);
create table content_bulk_plan_items (
  tenant_id uuid not null,
  plan_id uuid not null,
  plan_size integer not null,
  ordinal integer not null check (ordinal >= 0 and ordinal < plan_size),
  requested_item_id uuid not null,
  item_id uuid,
  base_revision_id uuid,
  latest_revision_id uuid,
  selection jsonb not null,
  publication jsonb not null,
  preview jsonb not null,
  primary key (tenant_id, plan_id, ordinal),
  unique (tenant_id, plan_id, requested_item_id),
  foreign key (tenant_id, plan_id, plan_size)
    references content_bulk_plans(tenant_id, id, item_count),
  foreign key (tenant_id, item_id) references content_items(tenant_id, id),
  foreign key (tenant_id, item_id, base_revision_id)
    references content_revisions(tenant_id, item_id, id),
  foreign key (tenant_id, item_id, latest_revision_id)
    references content_revisions(tenant_id, item_id, id),
  check (item_id is not null or (base_revision_id is null and latest_revision_id is null))
);
alter table content_bulk_plans enable row level security;
alter table content_bulk_plans force row level security;
create policy tenant_isolation on content_bulk_plans to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
alter table content_bulk_plan_items enable row level security;
alter table content_bulk_plan_items force row level security;
create policy tenant_isolation on content_bulk_plan_items to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert on content_bulk_plans, content_bulk_plan_items to mycel_app;

-- A complete immutable set at commit: all ordinal slots exist, so insert permission cannot
-- append an item to a previously committed plan. Deferred for the parent-first import order.
create function content_bulk_complete() returns trigger language plpgsql as $$
begin
  if (select count(*) from content_bulk_plan_items
      where tenant_id = new.tenant_id and plan_id = new.id) <> new.item_count then
    raise exception 'incomplete content bulk plan' using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger content_bulk_complete
  after insert on content_bulk_plans deferrable initially deferred
  for each row execute function content_bulk_complete();
