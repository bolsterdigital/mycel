-- 0048: the decided retention terms get a role, grants and a tenant setting (terms in
-- docs/reference/jobs.md § Retention, arithmetic in packages/core/src/ops/retention.ts).
--
-- `mycel_retention` deletes what passed its term inside one tenant's transaction: processed
-- outbox events with the mail intents that hung off them, form submissions, and admission seats
-- past their window. Shaped like `mycel_erasure` (0019): nologin, entered by the schema owner
-- only (`with set true, inherit false`), and every policy tests `current_tenant_id()`, so it
-- never works across tenants; the daily `retention.apply` visits the tenants one by one.
--
-- The policies carry the floors a wrong cut-off must not get under, whatever the query asks:
--   * an outbox event that is not processed can never be deleted (a dead event waits for ops);
--   * a mail intent goes only once its event is gone, never on its own;
--   * a submission younger than 28 days, the shortest month, can never be deleted (the lowest
--     term a tenant may choose is one calendar month).
-- What may still need a row (an open reconcile job, an open connection intent) is decided by the
-- statement in `packages/db/src/infra/retention.ts`; for that the role reads, and only reads,
-- `jobs` and `connection_intents` of the tenant.
--
-- Rejected: `mycel_erasure` for this (its grants are held to the erasure catalog, and a role that
-- tombstones supporters should not also run daily on every tenant); `mycel_janitor` (it deletes
-- across tenants without a tenant context, and would need to read submissions and outbox props of
-- every tenant); `mycel_worker` deleting its own queue rows across tenants (the mail intents and
-- the submissions are tenant tables it has no business in); a delete grant for `mycel_app` (the
-- public form path runs as that role).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mycel_retention') then
    create role mycel_retention nologin;
  end if;
end $$;
grant mycel_retention to current_user with set true, inherit false;
grant usage on schema public to mycel_retention;

grant select (id, tenant_id, processed_at, props), delete on outbox to mycel_retention;
create policy retention_read on outbox for select to mycel_retention
  using (tenant_id = current_tenant_id());
create policy retention_apply on outbox for delete to mycel_retention
  using (tenant_id = current_tenant_id() and processed_at is not null);
-- The retention scan: one tenant's processed events by age, outside `outbox_pending` (0003).
create index outbox_processed on outbox (tenant_id, processed_at) where processed_at is not null;

grant select (tenant_id, event_id), delete on mail_sends to mycel_retention;
create policy retention_read on mail_sends for select to mycel_retention
  using (tenant_id = current_tenant_id());
create policy retention_apply on mail_sends for delete to mycel_retention
  using (
    tenant_id = current_tenant_id()
    and not exists (select 1 from outbox o where o.id = mail_sends.event_id)
  );

grant select (tenant_id, type, done_at, payload) on jobs to mycel_retention;
create policy retention_read on jobs for select to mycel_retention
  using (tenant_id = current_tenant_id());

grant select (tenant_id, business_id, state) on connection_intents to mycel_retention;
create policy retention_read on connection_intents for select to mycel_retention
  using (tenant_id = current_tenant_id());

grant select (id, tenant_id, created_at, evaluation), delete on form_submissions to mycel_retention;
create policy retention_read on form_submissions for select to mycel_retention
  using (tenant_id = current_tenant_id());
create policy retention_apply on form_submissions for delete to mycel_retention
  using (tenant_id = current_tenant_id() and created_at < now() - interval '28 days');

grant select, delete on supporter_admissions to mycel_retention;
create policy retention_read on supporter_admissions for select to mycel_retention
  using (tenant_id = current_tenant_id());
create policy retention_apply on supporter_admissions for delete to mycel_retention
  using (tenant_id = current_tenant_id());

-- The tenant setting: a versioned document like `general` (0030). Null reads as the default (24
-- months), so every existing tenant gets the decided term without a backfill.
alter table site_settings
  add column retention jsonb,
  add column retention_version integer not null default 0 check (retention_version >= 0);
