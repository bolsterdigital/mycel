-- 0050: the person register of ADR 034 (#169 F). One row per erased person id of the people
-- register: who asked (kind and id, as on `erasures`) and when, never a name or an address.
-- Append-only like `erasures` (0019): mycel_app may insert and read its own tenant's rows, nobody
-- updates or deletes them. It travels in export/import and in the erasures snapshot beside the
-- supporter register, whose five-column format stays as it is (ADR 032 rule 6).
--
-- Apply (packages/db/src/person-erasures.ts, inside `ctx.erasures.apply()`) runs as
-- mycel_erasure and gets exactly what ADR 034 rules 3 and 4 need, each on the current tenant's
-- rows only: delete the person and their group memberships, and update the one JSON column of
-- revisions, patterns, plan slots and media where a credit sits. The update grants are column
-- grants, so the eraser cannot touch a revision's actor, item, time or id, and mycel_app still has
-- no update on revisions or plan slots (ADR 018, ADR 028), which rls.conformance.test.ts proves.
-- Rejected: a security-definer function (the owner sees no tenant row under forced RLS since
-- 0018), whole-row update grants (more than the scrub needs), and update grants for mycel_app (a
-- compromised front could then rewrite history it may only append to).

create table person_erasures (
  tenant_id   uuid not null references tenants(id),
  person_id   uuid not null,
  erased_at   timestamptz not null default now(),
  -- Who asked, as in erasures.actor: kind and id, never an address.
  actor       jsonb not null,
  primary key (tenant_id, person_id)
);

alter table person_erasures enable row level security;
alter table person_erasures force row level security;
create policy tenant_isolation on person_erasures to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert on person_erasures to mycel_app;

grant select on person_erasures to mycel_erasure;
create policy erasure_apply on person_erasures for select to mycel_erasure
  using (tenant_id = current_tenant_id());

-- Rule 3: the person and their memberships go; the ids elsewhere stay as inert references.
grant select (id, tenant_id), delete on people to mycel_erasure;
create policy erasure_apply on people to mycel_erasure
  using (tenant_id = current_tenant_id());
grant select (tenant_id, group_id, person_id), delete on person_group_members to mycel_erasure;
create policy erasure_apply on person_group_members to mycel_erasure
  using (tenant_id = current_tenant_id());

-- Rule 4: the targeted scrub of the free-text name beside an erased person id.
grant select (id, tenant_id, document), update (document) on content_revisions to mycel_erasure;
create policy erasure_apply on content_revisions to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select (id, tenant_id, blocks), update (blocks) on patterns to mycel_erasure;
create policy erasure_apply on patterns to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select (tenant_id, plan_id, ordinal, selection, preview), update (selection, preview)
  on content_bulk_plan_items to mycel_erasure;
create policy erasure_apply on content_bulk_plan_items to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select (id, tenant_id, credit), update (credit) on media to mycel_erasure;
create policy erasure_apply on media to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
