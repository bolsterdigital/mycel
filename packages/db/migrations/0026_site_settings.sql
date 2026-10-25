-- #11 E: validated tenant appearance and public chrome. Versions advance independently so
-- two editors working on different settings cannot overwrite one another.
create table site_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  theme jsonb not null,
  theme_version integer not null default 0 check (theme_version >= 0),
  chrome jsonb not null,
  chrome_version integer not null default 0 check (chrome_version >= 0)
);
alter table site_settings enable row level security;
alter table site_settings force row level security;
create policy tenant_isolation on site_settings to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on site_settings to mycel_app;
