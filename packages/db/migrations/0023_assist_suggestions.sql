-- 0023: tenant consent and bounded suggestions (ADR 021). Consent travels with a tenant export;
-- transient model output does not. RLS is forced on both tables, including worker reads.
-- Rejected: a provider result on the immutable content revision before an editor accepts it.

create table assist_settings (
  tenant_id uuid primary key references tenants (id) on delete cascade,
  enabled boolean not null default false,
  allow_restricted boolean not null default false,
  consented_provider text,
  consented_by uuid,
  consented_at timestamptz
);
alter table assist_settings enable row level security;
alter table assist_settings force row level security;
create policy tenant_isolation on assist_settings to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on assist_settings to mycel_app;

create table assist_suggestions (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  item_id uuid not null,
  base_revision_id uuid not null,
  block_id text not null,
  locale text not null,
  status text not null check (status in ('pending', 'ready', 'failed', 'accepted', 'dismissed')),
  value text,
  failure text check (failure in ('unavailable', 'timeout', 'rejected', 'invalid-output')),
  provider text not null,
  requested_by uuid,
  model text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  foreign key (tenant_id, item_id) references content_items (tenant_id, id) on delete cascade
);
create index assist_suggestions_item on assist_suggestions (tenant_id, item_id, created_at desc);
create index assist_suggestions_quota on assist_suggestions (tenant_id, created_at);
create index assist_suggestions_operator on assist_suggestions (tenant_id, requested_by, created_at);
alter table assist_suggestions enable row level security;
alter table assist_suggestions force row level security;
create policy tenant_isolation on assist_suggestions to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update, delete on assist_suggestions to mycel_app;

-- The output expires after 30 days, but a 31-day calendar month must keep its complete quota.
-- Keep a content-free monthly counter so retention cannot reopen the limit on day 31.
create table assist_usage (
  tenant_id uuid not null references tenants (id) on delete cascade,
  month date not null,
  count integer not null check (count >= 0),
  primary key (tenant_id, month)
);
alter table assist_usage enable row level security;
alter table assist_usage force row level security;
create policy tenant_isolation on assist_usage to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update, delete on assist_usage to mycel_app;

alter table content_revisions add column provenance jsonb;
