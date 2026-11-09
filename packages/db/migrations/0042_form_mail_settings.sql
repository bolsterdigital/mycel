-- Private mail configuration must never travel in the publicly readable form definition.
-- Rejected: resolving mutable templates at dispatch, or counting quotas in ephemeral memory.
create table form_mail_settings (
  tenant_id uuid primary key references tenants (id) on delete cascade,
  version integer not null check (version > 0),
  value jsonb not null
);
alter table form_mail_settings enable row level security;
alter table form_mail_settings force row level security;
create policy tenant_isolation on form_mail_settings to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on form_mail_settings to mycel_app;

-- One installation-local reservation counter per tenant, not personal data and not exported.
-- Calendar month is UTC. Reservations never refund after an ambiguous delivery or erasure.
create table form_mail_budget (
  tenant_id uuid primary key references tenants (id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  used integer not null check (used >= 0)
);
alter table form_mail_budget enable row level security;
alter table form_mail_budget force row level security;
create policy tenant_isolation on form_mail_budget to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on form_mail_budget to mycel_app;

-- The eraser distinguishes personalised mail bodies from other event payloads. It already
-- reads id/props and updates props (0019); this adds only the event-kind column it now needs.
grant select (type) on outbox to mycel_erasure;
