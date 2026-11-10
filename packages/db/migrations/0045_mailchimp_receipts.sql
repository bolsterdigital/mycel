-- Pre-effect observations distinguish a new provider confirmation from historic subscriptions.
-- Rejected: keeping a baseline in a process-local cache that a timeout or restart can lose.
create table mailchimp_receipts (
  tenant_id uuid not null references tenants(id) on delete cascade,
  intent_id uuid primary key,
  connection_id uuid not null,
  supporter_id uuid not null,
  member_hash text not null,
  baseline_status text not null check (baseline_status in ('absent','subscribed','unsubscribed','cleaned','pending','transactional','archived')),
  baseline_changed_at timestamptz,
  requested_at timestamptz not null,
  status text not null check (status in ('absent','subscribed','unsubscribed','cleaned','pending','transactional','archived')),
  observed_at timestamptz not null,
  confirmed_at timestamptz,
  retryable boolean not null default false,
  foreign key (tenant_id, connection_id) references connections(tenant_id, id) on delete cascade,
  foreign key (tenant_id, intent_id) references connection_intents(tenant_id, id) on delete cascade
);
create index mailchimp_receipts_supporter on mailchimp_receipts(tenant_id, supporter_id);
alter table mailchimp_receipts enable row level security;
alter table mailchimp_receipts force row level security;
create policy tenant_isolation on mailchimp_receipts to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on mailchimp_receipts to mycel_app;
grant select, delete on mailchimp_receipts to mycel_erasure;
create policy erasure_select on mailchimp_receipts to mycel_erasure
  using (tenant_id = current_tenant_id());
create policy erasure_delete on mailchimp_receipts to mycel_erasure
  using (tenant_id = current_tenant_id());
create index mailchimp_receipts_member on mailchimp_receipts(tenant_id, connection_id, member_hash, requested_at desc);
alter table connections drop constraint connections_provider_check;
alter table connections add constraint connections_provider_check check (provider in ('webhook', 'mailchimp'));
