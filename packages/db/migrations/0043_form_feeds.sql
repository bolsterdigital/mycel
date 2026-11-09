-- Feed destinations and author authority are private tenant configuration, not public forms.
-- Rejected: trusting a posted destination or adding personal payload copies to connection jobs.
create table form_feed_settings (
  tenant_id uuid primary key references tenants (id) on delete cascade,
  version integer not null check (version > 0),
  value jsonb not null,
  actor jsonb not null
);
alter table form_feed_settings enable row level security;
alter table form_feed_settings force row level security;
create policy tenant_isolation on form_feed_settings to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on form_feed_settings to mycel_app;
create index form_submissions_feed_actions on form_submissions using gin ((evaluation->'feedActions'));
