-- 0024: tenant-owned connector inventory; credentials stay encrypted and installation-local.
-- Rejected: credentials in the exportable row, which would copy secrets into tenant archives.

create table connections (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  provider text not null check (provider in ('webhook', 'mailchimp')),
  account_ref text,
  external_owner text not null,
  maintainer text not null,
  purpose text not null,
  direction text not null check (direction in ('outbound', 'inbound', 'bidirectional')),
  data_authority text not null check (data_authority in ('mycel', 'external')),
  consent_authority text not null check (consent_authority in ('mycel', 'external')),
  consent_scopes jsonb not null,
  form_ids uuid[] not null,
  destination text,
  contract_version text not null,
  adapter_version text not null,
  state text not null check (state in ('active', 'paused', 'disconnected')),
  version integer not null check (version > 0),
  credential_version integer not null check (credential_version >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, id)
);
create index connections_tenant on connections (tenant_id, created_at desc);
alter table connections enable row level security;
alter table connections force row level security;
create policy tenant_isolation on connections to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on connections to mycel_app;

create table connection_credentials (
  connection_id uuid primary key,
  tenant_id uuid not null,
  ciphertext text not null,
  updated_at timestamptz not null,
  foreign key (tenant_id, connection_id) references connections (tenant_id, id) on delete cascade
);
alter table connection_credentials enable row level security;
alter table connection_credentials force row level security;
create policy tenant_isolation on connection_credentials to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update, delete on connection_credentials to mycel_app;
