-- 0054: the installation erases an operator account, and repairs a tenant left without an admin
-- (ADR 035 rules 1 to 3). Migration 0053 took the address out of every stored actor;
-- this migration adds what the two platform operations in packages/db/src/operators/erasure.ts
-- need, and nothing for any other role.
--
-- `operator_erasures` is the installation register of rule 2: one row per erased operator id and
-- when, never an address or a name. Installation data like `tenants` (no tenant_id, no RLS): an
-- operator may have served several tenants and the register outlives all of them. Append-only:
-- mycel_platform may read and insert, nobody updates or deletes, and the erasures backup copies it
-- (docker/backup/backup.sh) so a restore can erase the registered operators again.
--
-- The grants to mycel_platform (0010), each as narrow as the operations need:
--   * operators: read every row and delete one (rule 3: the account, a pending invitation
--     included, its issuer and subject, and the preferences that live on the row);
--   * tenant_memberships and api_keys: read across tenants, to find every tenant the operator
--     served and every key they made; write only inside a tenant context (`app.tenant_id`, set by
--     the operation per tenant under that tenant's membership lock), and only what erasure and
--     the admin restore change: delete or add a membership, add `tenant:admin` to one, revoke a key;
--   * tenant_exports: expire the archives of an affected tenant (rule 5), the columns the eraser
--     (0022) may change and no other;
--   * operator_for_invite: the restore invites through the same function as
--     `tenant.member.invite`; it still refuses without a tenant context.
-- audit_log already takes the platform's own rows (0015, actor kind `platform`).
-- Rejected: a security-definer function per operation (the owner sees no tenant row under forced
-- RLS since 0018), `using (true)` for writes (one wrong tenant id in the code would write in
-- another tenant), and entering mycel_app with a constructed principal (ADR 035 rejects a forged
-- admin outside the platform boundary).

create table operator_erasures (
  operator_id  uuid primary key,
  erased_at    timestamptz not null default now()
);
grant select, insert on operator_erasures to mycel_platform;

grant select, delete on operators to mycel_platform;
create policy platform_operators on operators to mycel_platform using (true);

grant select, insert, update (capabilities), delete on tenant_memberships to mycel_platform;
create policy platform_read on tenant_memberships for select to mycel_platform using (true);
create policy platform_write on tenant_memberships for insert to mycel_platform
  with check (tenant_id = current_tenant_id());
create policy platform_update on tenant_memberships for update to mycel_platform
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
create policy platform_delete on tenant_memberships for delete to mycel_platform
  using (tenant_id = current_tenant_id());

grant select, update (revoked_at) on api_keys to mycel_platform;
create policy platform_read on api_keys for select to mycel_platform using (true);
create policy platform_revoke on api_keys for update to mycel_platform
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

grant select (id, tenant_id, status, requested_at), update (status, error, expires_at)
  on tenant_exports to mycel_platform;
create policy platform_expire on tenant_exports to mycel_platform
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

grant execute on function operator_for_invite(text, uuid) to mycel_platform;
