-- 0015: the audit log (TODO #17b, brief observability-b-audit). One row per command, written by
-- the Invoker as mycel_app in the command's own transaction (success) or in a short transaction of
-- its own (refusal, failure); one row per platform mutation, written by packages/db/src/platform.ts
-- as mycel_platform. Who did what and how it ended, never the data itself: the actor is an id
-- (never an address), the input a keyed hash (HMAC-SHA256 under AUDIT_HASH_KEY), so a row holds
-- no personal data beyond pseudonymous ids (ADR 019 rule 8).
--
-- Append-only. mycel_app may insert and read its own tenant's rows and nothing more; nobody
-- updates; only `mycel_audit_janitor` deletes, and only rows older than 30 days whatever its
-- query says (the `audit.retention` job, AUDIT_RETENTION_DAYS). Rejected: a trigger per table
-- (sees no principal), and reusing `mycel_janitor` (its grant is `rate_limits`; sharing it would
-- make either grant wider than its job). No partitioning yet: docs/reference/audit.md says when.

create table audit_log (
  id           uuid primary key,
  -- Null: a platform action without a tenant. Every command has one.
  tenant_id    uuid references tenants(id),
  occurred_at  timestamptz not null default now(),
  actor_kind   text not null
                 check (actor_kind in ('operator', 'api-key', 'agent', 'system', 'anonymous',
                                       'platform')),
  -- operatorId, keyId, job name or token fingerprint; null for an anonymous visitor.
  actor_id     text check (char_length(actor_id) <= 200),
  -- The use-case name or `platform.<action>`.
  operation    text not null check (char_length(operation) between 1 and 100),
  effect       text check (effect in ('publish', 'send', 'export', 'refund')),
  input_hash   text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  -- ok, a UseCaseError code, or error.
  result       text not null check (char_length(result) between 1 and 40),
  request_id   text check (char_length(request_id) <= 64),
  subject_id   text check (char_length(subject_id) <= 200)
);
create index audit_log_tenant_occurred on audit_log (tenant_id, occurred_at desc, id desc);
-- The retention scan, across tenants.
create index audit_log_occurred on audit_log (occurred_at);

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy tenant_isolation on audit_log to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert on audit_log to mycel_app;

-- The platform API and CLI (0010's role) append their own rows and only their own kind.
grant insert on audit_log to mycel_platform;
create policy platform_audit on audit_log for insert to mycel_platform
  with check (actor_kind = 'platform');

-- Retention (ADR 011 rule 2): its own role, entered with `set local role` by the worker. It sees
-- and deletes only rows older than 30 days: the floor is in the database, so a wrong
-- AUDIT_RETENTION_DAYS or a hand-written `where` can never erase a fresh trail.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mycel_audit_janitor') then
    create role mycel_audit_janitor nologin;
  end if;
end $$;
grant mycel_audit_janitor to current_user;
grant usage on schema public to mycel_audit_janitor;
grant select, delete on audit_log to mycel_audit_janitor;
create policy audit_retention_read on audit_log for select to mycel_audit_janitor
  using (occurred_at < now() - interval '30 days');
create policy audit_retention on audit_log for delete to mycel_audit_janitor
  using (occurred_at < now() - interval '30 days');
