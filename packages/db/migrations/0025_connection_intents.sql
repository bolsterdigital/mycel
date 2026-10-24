-- Durable connection effects and redacted attempt history. Operational, not replayable exports:
-- importing unfinished intents into another installation could duplicate external effects.
create table connection_intents (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  connection_id uuid not null,
  business_id uuid not null,
  connection_version integer not null check (connection_version > 0),
  credential_version integer not null check (credential_version > 0),
  source text not null,
  mapping_version text not null,
  supporter_id uuid,
  scope text not null,
  actor jsonb not null,
  key text not null,
  state text not null check (state in ('pending','unknown','succeeded','blocked','failed')),
  failure text,
  attempts integer not null check (attempts >= 0),
  revision integer not null check (revision >= 0),
  lease_token uuid,
  lease_until timestamptz,
  next_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(tenant_id, id),
  unique(tenant_id, connection_id, business_id),
  unique(tenant_id, key),
  foreign key(tenant_id, connection_id) references connections(tenant_id, id) on delete cascade
);
create index connection_intents_supporter on connection_intents(tenant_id, supporter_id);
alter table connection_intents enable row level security;
alter table connection_intents force row level security;
create policy tenant_isolation on connection_intents to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on connection_intents to mycel_app;

create table connection_attempts (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  intent_id uuid not null,
  at timestamptz not null,
  kind text not null check (kind in ('dispatch','reconcile')),
  outcome text not null check (outcome in ('started','succeeded','absent','unknown','pre_send','blocked')),
  foreign key(tenant_id,intent_id) references connection_intents(tenant_id,id) on delete cascade
);
create index connection_attempts_intent on connection_attempts(tenant_id,intent_id,at);
alter table connection_attempts enable row level security;
alter table connection_attempts force row level security;
create policy tenant_isolation on connection_attempts to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert on connection_attempts to mycel_app;
-- Keep anonymous delivery uncertainty visible after erasure, but detach the local identity.
create policy erasure on connection_intents to mycel_erasure
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select on connection_intents to mycel_erasure;
grant update(supporter_id, state, failure, lease_token, lease_until, revision) on connection_intents to mycel_erasure;
