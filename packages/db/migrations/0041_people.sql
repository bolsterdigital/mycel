-- One person can write, make images and appear in a team. Rename in place to preserve ids,
-- timestamps and references; rejected: copying authors into a second identity table.
alter table authors rename to people;
alter table people add column role jsonb;
alter table people add column organisation text;
alter table people add column public_email text;
alter table people add column phone text;
alter table people add column page_policy text not null default 'auto'
  check (page_policy in ('auto', 'always', 'never'));
alter table people add unique (tenant_id, id);

create table person_groups (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  name jsonb not null,
  sort_order integer not null default 0 check (sort_order between 0 and 10000),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, id)
);
create table person_group_members (
  tenant_id uuid not null references tenants(id),
  group_id uuid not null,
  person_id uuid not null,
  sort_order integer not null check (sort_order >= 0),
  primary key (tenant_id, group_id, person_id),
  unique (tenant_id, group_id, sort_order),
  foreign key (tenant_id, group_id) references person_groups(tenant_id, id),
  foreign key (tenant_id, person_id) references people(tenant_id, id)
);
alter table person_groups enable row level security;
alter table person_groups force row level security;
create policy tenant_isolation on person_groups to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on person_groups to mycel_app;
alter table person_group_members enable row level security;
alter table person_group_members force row level security;
create policy tenant_isolation on person_group_members to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, delete on person_group_members to mycel_app;
