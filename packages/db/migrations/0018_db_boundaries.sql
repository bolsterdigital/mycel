-- 0018: database boundaries of the fronts made enforceable (TODO #20b, brief security-b-db-boundaries;
-- ADR 002 rules 3 and 4, ADR 011 rules 1 and 2).
--
-- 1. Every `tenant_isolation` policy is bound to `mycel_app`. Until now the older tables had
--    theirs on `public`, so any future role with an insert grant on such a table would silently
--    fall under that policy instead of being refused. From here on the schema owner sees no tenant
--    row either: forced RLS plus a policy for mycel_app only. Owner paths that write tenant data
--    (the seed, fixtures, backfill replays) enter mycel_app per transaction with `set local role`,
--    which 0016 granted the owner (`with set true, inherit false`). Rejected: a second policy for
--    the owner (exactly the gap this closes) and `bypassrls` on the owner (ADR 002 rule 4).
--
-- 2. The login limit counts in Postgres instead of per process. With two web processes behind
--    Caddy an in-memory window doubled the limit. `login_attempts` is a platform counter without
--    `tenant_id`: login happens before there is a tenant. Its key is the HMAC of the client address
--    (`Signer.hashIp`), never an address. Written through `mycel_auth`, which the fronts enter from
--    the `mycel_authenticator` login (0007). Rejected: Redis or another shared store (ADR 008, one
--    more service for one counter), the tenant `rate_limits` with a sentinel tenant (breaks its
--    foreign key and what `tenant_isolation` means), and sticky sessions in Caddy (the limit would
--    depend on hosting we do not always run ourselves).

alter policy tenant_isolation on api_keys to mycel_app;
alter policy tenant_isolation on authors to mycel_app;
alter policy tenant_isolation on content_block_refs to mycel_app;
alter policy tenant_isolation on content_item_locales to mycel_app;
alter policy tenant_isolation on content_items to mycel_app;
alter policy tenant_isolation on content_revisions to mycel_app;
alter policy tenant_isolation on events to mycel_app;
alter policy tenant_isolation on form_submissions to mycel_app;
alter policy tenant_isolation on forms to mycel_app;
alter policy tenant_isolation on mail_sends to mycel_app;
alter policy tenant_isolation on outbox to mycel_app;
alter policy tenant_isolation on patterns to mycel_app;
alter policy tenant_isolation on rate_limits to mycel_app;
alter policy tenant_isolation on sections to mycel_app;
alter policy tenant_isolation on supporter_admissions to mycel_app;
alter policy tenant_isolation on supporters to mycel_app;
alter policy tenant_isolation on tenant_memberships to mycel_app;

-- A table this list missed would keep a `public` policy; fail the migration rather than ship it.
do $$
declare
  loose text;
begin
  select string_agg(tablename || '.' || policyname, ', ') into loose
  from pg_policies where schemaname = 'public' and 'public' = any(roles);
  if loose is not null then
    raise exception 'policies still bound to public: %', loose;
  end if;
end $$;

create table login_attempts (
  key           text not null check (length(key) between 16 and 128),
  window_start  timestamptz not null,
  hits          int not null check (hits > 0),
  primary key (key, window_start)
);
alter table login_attempts enable row level security;
alter table login_attempts force row level security;
grant select, insert, update on login_attempts to mycel_auth;
create policy auth_login_limit on login_attempts for all to mycel_auth
  using (true) with check (true);

-- The janitor sweeps the windows with the rate-limit windows (`rate_limits.sweep`). A delete
-- policy cannot find rows without a select policy for the same role (0006); both reach only
-- windows older than a day, so a sweep can never reset a live count whatever its query asks.
grant select, delete on login_attempts to mycel_janitor;
create policy janitor_read on login_attempts for select to mycel_janitor
  using (window_start < now() - interval '1 day');
create policy janitor_sweep on login_attempts for delete to mycel_janitor
  using (window_start < now() - interval '1 day');

-- 3. The recovery `ensure_event_partitions` names (0009) put the moved rows back through the
--    `events` parent, as the schema owner. With the parent's policy bound to mycel_app that insert
--    is refused for an owner that is not a superuser. The rows go into the new month's partition
--    instead: the owner owns it, it carries no RLS of its own (the parent covers it for every
--    other role, 0005), and it takes every tenant's rows in one statement where the parent took
--    one tenant's per context. Same signature and grants; only the message changes. Rejected:
--    the recovery as mycel_app (one transaction per tenant, and mycel_app cannot read the owner's
--    temporary table).
create or replace function ensure_event_partitions(from_month date, to_month date) returns integer
language plpgsql set search_path = public as $$
declare
  m date;
  lo text;
  hi text;
  stray bigint;
  created integer := 0;
begin
  m := date_trunc('month', from_month)::date;
  while m <= date_trunc('month', to_month)::date loop
    if to_regclass(format('public.events_%s', to_char(m, 'YYYY_MM'))) is null then
      lo := m::text || ' 00:00:00+00';
      hi := (m + interval '1 month')::date::text || ' 00:00:00+00';
      select count(*) into stray from events_default
        where occurred_at >= lo::timestamptz and occurred_at < hi::timestamptz;
      if stray > 0 then
        raise exception '%', format(
          'events_default holds %s row(s) from %s, so their partition cannot be created. Move '
          'them in one transaction as the schema owner: create temp table moved as select * from '
          'events_default where occurred_at >= %L and occurred_at < %L; delete from '
          'events_default where occurred_at >= %L and occurred_at < %L; select '
          'ensure_event_partitions(%L, %L); insert into %I select * from moved;',
          stray, to_char(m, 'YYYY-MM'), lo, hi, lo, hi, m, m,
          format('events_%s', to_char(m, 'YYYY_MM')));
      end if;
    end if;
    m := (m + interval '1 month')::date;
  end loop;

  m := date_trunc('month', from_month)::date;
  while m <= date_trunc('month', to_month)::date loop
    if to_regclass(format('public.events_%s', to_char(m, 'YYYY_MM'))) is null then
      execute format(
        'create table %I partition of events for values from (%L) to (%L)',
        format('events_%s', to_char(m, 'YYYY_MM')),
        m::text || ' 00:00:00+00',
        (m + interval '1 month')::date::text || ' 00:00:00+00'
      );
      created := created + 1;
    end if;
    m := (m + interval '1 month')::date;
  end loop;
  return created;
end $$;
