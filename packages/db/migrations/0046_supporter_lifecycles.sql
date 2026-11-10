-- Explicit readmission evidence survives queue retries, export and restore (ADR 032).
-- Rejected: reusing the erased id, or treating a later event timestamp as consent.
create table supporter_lifecycles (
  tenant_id uuid not null references tenants(id),
  id uuid not null,
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  submission_id uuid not null,
  started_at timestamptz not null,
  primary key (tenant_id, id),
  unique (tenant_id, submission_id)
);
create index supporter_lifecycles_hash on supporter_lifecycles (tenant_id, email_hash);
alter table supporter_lifecycles enable row level security;
alter table supporter_lifecycles force row level security;
create policy tenant_isolation on supporter_lifecycles to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert on supporter_lifecycles to mycel_app;
create policy erasure_apply on supporter_lifecycles for select to mycel_erasure
  using (tenant_id = current_tenant_id());
grant select on supporter_lifecycles to mycel_erasure;
