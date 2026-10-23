-- 0022: self-service export (TODO #28, brief tenant-self-export; ADR 002 rule 5, ADR 015 rule 7,
-- ADR 019 rule 8). One row per archive a tenant administrator asked for. The `tenant.export` job
-- builds the archive with `exportTenant` and writes it to the blob store under
-- `exports/<tenant id>/<export id>.tar`, outside the media prefix `tenants/<id>/` (an archive
-- there would travel in the next export and be swept as an orphan). The key is derived from
-- tenant and id, so it is not a column: this table is readable through the API.
--
-- An archive is the most sensitive copy of a tenant's data, so every row has a lifetime:
-- `expires_at` (finished + EXPORT_RETENTION_DAYS) and `purged_at` once its file is gone. The daily
-- `tenant.export.expire` job expires and purges; `erasures.apply` expires every archive that may
-- hold an erased person, as mycel_erasure below, and the job or the CLI purges its file.
--
-- At most one export per tenant is queued or running (the partial unique index), so a double
-- click or an agent in a loop cannot have ten full archives built. Tenant data under forced RLS
-- like every tenant table; `operational` in export.ts TABLES: an archive does not travel in the
-- next export. Rejected: the blob key as a column (readable to anyone who may list exports) and a
-- status on the job row (jobs are deleted after JOBS_RETENTION_DAYS and carry no tenant view).

create table tenant_exports (
  id              uuid primary key,
  tenant_id       uuid not null references tenants(id),
  -- `actorRef` of who asked (`operator:<id>`), never an address.
  requested_by    text not null check (char_length(requested_by) between 1 and 200),
  requested_at    timestamptz not null default now(),
  status          text not null default 'queued'
                    check (status in ('queued', 'running', 'ready', 'failed', 'expired')),
  started_at      timestamptz,
  heartbeat_at    timestamptz,
  finished_at     timestamptz,
  size_bytes      bigint check (size_bytes >= 0),
  sha256          text check (sha256 ~ '^[0-9a-f]{64}$'),
  schema_version  text,
  -- Scrubbed when written (`scrubText`): an exception may quote an address.
  error           text check (char_length(error) <= 1000),
  expires_at      timestamptz,
  purged_at       timestamptz,
  check (status <> 'ready' or (size_bytes is not null and sha256 is not null
                               and expires_at is not null))
);
create unique index tenant_exports_active on tenant_exports (tenant_id)
  where status in ('queued', 'running');
create index tenant_exports_tenant_requested on tenant_exports (tenant_id, requested_at desc, id desc);

alter table tenant_exports enable row level security;
alter table tenant_exports force row level security;
create policy tenant_isolation on tenant_exports to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update, delete on tenant_exports to mycel_app;

-- ADR 019 rule 8: an erasure covers every copy, archives included. Only the columns that expire
-- a row; the file goes after commit (`purgeExpiredExports`).
grant select (id, tenant_id, status, requested_at), update (status, error, expires_at) on tenant_exports
  to mycel_erasure;
create policy erasure_apply on tenant_exports to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
