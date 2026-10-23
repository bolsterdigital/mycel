-- 0019: the erasure register (TODO #18d, brief production-and-restore § 14; ADR 003 rule 5,
-- ADR 019 rule 8). One row per erased supporter: who, when, and a hash of the address, never the
-- address itself. The register is what makes an erasure survive a restore: a backup taken before
-- the erasure still holds the person, and `mycel erasures apply` after a restore erases them again
-- from the register of the newer backup. A registration is permanent: mycel_app may insert and
-- read its own tenant's rows, nobody updates or deletes them.
--
-- Applying a registration needs rights mycel_app does not and should not have: the event log is
-- append-only for mycel_app (0005), submissions and mail intents are never deleted by it, and it
-- cannot read the outbox or the jobs payload. `mycel_erasure` holds exactly those rights, each on
-- the current tenant's rows only (the policies below test `current_tenant_id()`, like
-- tenant_isolation), and only the columns an erasure overwrites. Like the other background roles
-- it cannot log in; the schema owner enters it with `set local role` from inside a tenant
-- transaction (`ctx.erasures.apply`, packages/db/src/erasures.ts). The fronts' mycel_app login is
-- not a member, so an erasure is applied by the worker or the CLI, never by a web request.
-- Rejected: `mycel_worker` for the outbox part (its policies reach every tenant, and an erasure is
-- one tenant's business), a security-definer function (the owner sees no tenant row under forced
-- RLS since 0018, and `set role` is not allowed inside one), and update/delete grants for
-- mycel_app (a compromised front could then rewrite the log it is meant to append to).

create table erasures (
  tenant_id     uuid not null references tenants(id),
  supporter_id  uuid not null,
  -- sha256 hex of `tenant_id || E'\n' || lower(email)`: lets a restore find the address in a
  -- submission without a supporter row, without the register holding the address.
  email_hash    text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  erased_at     timestamptz not null default now(),
  -- Who asked, as in content_revisions.actor: kind and id, never an address.
  actor         jsonb not null,
  primary key (tenant_id, supporter_id)
);
create index erasures_hash on erasures (tenant_id, email_hash);

alter table erasures enable row level security;
alter table erasures force row level security;
create policy tenant_isolation on erasures to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert on erasures to mycel_app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mycel_erasure') then
    create role mycel_erasure nologin;
  end if;
end $$;
-- `set`, not `inherit`: the owner's own queries never carry these rights by accident (0016).
grant mycel_erasure to current_user with set true, inherit false;
grant usage on schema public to mycel_erasure;

grant select on erasures to mycel_erasure;
create policy erasure_apply on erasures for select to mycel_erasure
  using (tenant_id = current_tenant_id());

-- Tombstones (ADR 003 rule 5): the address and the props go, type and time stay.
grant select, update (email, props) on events to mycel_erasure;
create policy erasure_apply on events to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

grant select, update (email, lists, pending_lists, updated_at) on supporters to mycel_erasure;
create policy erasure_apply on supporters to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

grant select, delete on form_submissions to mycel_erasure;
create policy erasure_apply on form_submissions to mycel_erasure
  using (tenant_id = current_tenant_id());

grant select (id, tenant_id, props), update (props) on outbox to mycel_erasure;
create policy erasure_apply on outbox to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

grant select, delete on mail_sends to mycel_erasure;
create policy erasure_apply on mail_sends to mycel_erasure
  using (tenant_id = current_tenant_id());

grant select (id, tenant_id, type, payload), delete on jobs to mycel_erasure;
create policy erasure_apply on jobs to mycel_erasure
  using (tenant_id = current_tenant_id());
