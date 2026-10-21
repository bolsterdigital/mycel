-- 0007: operators, their memberships of tenants, and API keys (TODO #7; ADR 002 rules 3 and 4,
-- ADR 011 rule 1).
--
-- `operators` is platform data: one row per person, identified by the IdP's (issuer, subject)
-- after the first login, or by an address alone while an invitation waits (subject null).
-- `tenant_memberships` and `api_keys` are tenant data under forced RLS like every other table.
--
-- Two readers, two shapes:
--   * Authentication happens before a tenant context exists. It runs as `mycel_auth` (nologin,
--     entered with `set local role` per transaction, ADR 011 rule 2), which may read memberships
--     and keys of every tenant and is the only role that writes `operators` rows of logged-in
--     people. The fronts reach it through `mycel_authenticator`, a login whose only power is
--     entering `mycel_auth`: web and API never hold the schema owner's credentials for this.
--   * Managing members and keys is a use case: `mycel_app` under RLS. It sees operators only
--     when they are members of its current tenant (policy `member_read`, a few columns), and
--     reaches the rest through one function, `operator_for_invite`, which can create a pending
--     row or name the operator an invitation goes to, but never link a subject.
--
-- Rejected: `select` on all of `operators` for mycel_app (every tenant could read every
-- operator's address), SECURITY DEFINER functions that log people in (an injection as the app
-- role could then link subjects; `set role` is structurally out of its reach), and memberships
-- and keys as platform data without RLS (member lists and key hashes of all tenants readable by
-- any app transaction).

create table operators (
  id                 uuid primary key,
  issuer             text,
  subject            text,
  email              text not null check (email = lower(btrim(email))),
  email_verified_at  timestamptz,
  name               text,
  created_at         timestamptz not null default now(),
  last_login_at      timestamptz,
  check ((issuer is null) = (subject is null)),
  unique (issuer, subject)
);
-- One waiting invitation per address; logged-in operators may share an address (two accounts).
create unique index operators_pending_email on operators (email) where subject is null;
create index operators_email on operators (email);

create table tenant_memberships (
  tenant_id     uuid not null references tenants(id),
  operator_id   uuid not null references operators(id),
  capabilities  text[] not null check (cardinality(capabilities) > 0),
  created_at    timestamptz not null default now(),
  primary key (tenant_id, operator_id)
);
create index tenant_memberships_operator on tenant_memberships (operator_id);
alter table tenant_memberships enable row level security;
alter table tenant_memberships force row level security;
create policy tenant_isolation on tenant_memberships
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update, delete on tenant_memberships to mycel_app;

create table api_keys (
  id            uuid primary key,
  tenant_id     uuid not null references tenants(id),
  name          text not null,
  -- The first twelve characters of the token, to recognise a key in a list.
  prefix        text not null,
  -- SHA-256 hex of the whole token; the token itself is shown once and never stored.
  key_hash      text not null unique,
  capabilities  text[] not null
                check (cardinality(capabilities) > 0 and not ('tenant:admin' = any (capabilities))),
  -- The actor who created it (ADR 009 rule 9); the membership rules revoke an operator's keys.
  created_by    jsonb not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index api_keys_tenant on api_keys (tenant_id);
alter table api_keys enable row level security;
alter table api_keys force row level security;
create policy tenant_isolation on api_keys
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
-- No delete: revoking sets revoked_at and the row stays for attribution.
grant select, insert on api_keys to mycel_app;
grant update (last_used_at, revoked_at) on api_keys to mycel_app;

-- The authentication role (ADR 011 rules 1 and 2): same shape as mycel_worker and mycel_janitor.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mycel_auth') then
    create role mycel_auth nologin;
  end if;
  -- Login role of the fronts for authentication; migrate sets its password from
  -- MYCEL_AUTH_PASSWORD, as it does for mycel_app.
  if not exists (select 1 from pg_roles where rolname = 'mycel_authenticator') then
    create role mycel_authenticator nologin;
  end if;
end $$;
grant mycel_auth to current_user;
-- Without inherit: the login has no table rights of its own and must `set role mycel_auth`.
grant mycel_auth to mycel_authenticator with inherit false;
grant usage on schema public to mycel_auth;
grant select, insert, update on operators to mycel_auth;
grant select on tenant_memberships, api_keys, tenants to mycel_auth;
create policy auth_lookup on tenant_memberships for select to mycel_auth using (true);
create policy auth_lookup on api_keys for select to mycel_auth using (true);

-- Operators: RLS enabled, not forced, so the owner (migrations, operator_for_invite) is not
-- bound by it. mycel_auth reads and writes every row; mycel_app reads members of its tenant.
alter table operators enable row level security;
create policy auth_lookup on operators to mycel_auth using (true) with check (true);
create policy member_read on operators for select to mycel_app
  using (exists (select 1 from tenant_memberships m where m.operator_id = operators.id));
grant select (id, email, name, last_login_at) on operators to mycel_app;

-- The operator an invitation for `p_email` goes to (operators/ports.ts `forInvite`): the pending
-- row for the address, else the one operator who logged in with it verified, else a new pending
-- row `p_new_id`. Null when several verified operators share the address. Runs as the owner; only
-- mycel_app may call it, and only inside a tenant transaction.
create function operator_for_invite(p_email text, p_new_id uuid) returns uuid
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp
as $$
declare
  found uuid;
  verified uuid[];
begin
  if current_tenant_id() is null then
    raise exception 'operator_for_invite needs a tenant context' using errcode = '42501';
  end if;
  if p_email is distinct from lower(btrim(p_email)) then
    raise exception 'operator_for_invite expects a normalised address' using errcode = '22023';
  end if;
  select id into found from operators where subject is null and email = p_email;
  if found is not null then
    return found;
  end if;
  select array_agg(id) into verified
    from operators where subject is not null and email = p_email and email_verified_at is not null;
  if cardinality(verified) > 1 then
    return null;
  elsif cardinality(verified) = 1 then
    return verified[1];
  end if;
  insert into operators (id, email) values (p_new_id, p_email)
    on conflict (email) where subject is null do nothing;
  -- A concurrent invitation may have inserted the pending row first; either way there is one.
  select id into found from operators where subject is null and email = p_email;
  return found;
end $$;
revoke all on function operator_for_invite(text, uuid) from public;
grant execute on function operator_for_invite(text, uuid) to mycel_app;
