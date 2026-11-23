-- 0088: a site import from the admin (MY-257 PR 3, brief wordpress-import-execution § PR 3). One
-- row per WordPress export an administrator uploaded: the summary of the dry run, and once the
-- `content.import` job ran, what it made and every remark. The run itself writes through the use
-- cases as the tenant's `importer`; this table only records it.
--
-- The uploaded file holds the source site's users with their addresses, so it sits on the row
-- (`source`) only until the run finishes or the import is deleted, never in the blob store, where
-- a file outlives its row. The report names people of the source site (authors, team), so a row
-- is deleted after 30 days by `retention.apply` as mycel_retention, and by the administrator at
-- any time (`content.import.delete`). No operator id: who uploaded and who started are in the
-- audit rows the commands write, which keeps this table out of operator erasure (ADR 035).
--
-- At most one import per site is queued or running (the partial unique index). Tenant data under
-- forced RLS; `operational` in export.ts TABLES: an import record does not travel with the site.
-- Rejected: the file in the blob store (a second lifetime to keep in step) and the status on the
-- job row (jobs are deleted after JOBS_RETENTION_DAYS and carry no tenant view).

create table content_imports (
  id            uuid primary key,
  tenant_id     uuid not null references tenants(id),
  file_name     text not null check (char_length(file_name) between 1 and 200),
  -- 25 MB, as `content.import.upload` accepts; null once the run ended.
  source        bytea check (octet_length(source) <= 26214400),
  status        text not null default 'planned'
                  check (status in ('planned', 'queued', 'running', 'done', 'failed')),
  into_existing boolean not null default false,
  summary       jsonb not null,
  outcome       jsonb,
  -- Scrubbed when written (`importFailure`): an exception may quote an address.
  error         text check (char_length(error) <= 1000),
  created_at    timestamptz not null,
  started_at    timestamptz,
  finished_at   timestamptz,
  check (status not in ('done', 'failed') or (source is null and finished_at is not null)),
  check (status <> 'done' or outcome is not null)
);
create unique index content_imports_active on content_imports (tenant_id)
  where status in ('queued', 'running');
create index content_imports_tenant_created on content_imports (tenant_id, created_at desc, id desc);

alter table content_imports enable row level security;
alter table content_imports force row level security;
create policy tenant_isolation on content_imports to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update, delete on content_imports to mycel_app;

-- Retention (0048): one tenant's finished or forgotten imports by age, never a running one.
grant select (tenant_id, id, status, created_at), delete on content_imports to mycel_retention;
create policy retention_read on content_imports for select to mycel_retention
  using (tenant_id = current_tenant_id());
create policy retention_apply on content_imports for delete to mycel_retention
  using (tenant_id = current_tenant_id() and status not in ('queued', 'running'));
