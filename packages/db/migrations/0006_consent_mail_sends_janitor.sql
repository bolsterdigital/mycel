-- 0006: double opt-in as a fact, the intent row for transactional mail, and a janitor role
-- (ADR 010 rule 5, ADR 019 rule 6, ADR 011 rule 2).
--
-- `form_submissions.confirmed_at` is set once by `mailing.confirm` with a conditional update; that
-- single row is what makes a second click a no-op. `supporters.pending_lists` holds the lists a
-- supporter signed up for but has not confirmed. `mail_sends` is written before every provider
-- call and completed after it; its state is derived from `attempted_at` and `sent_at`, there is
-- no status column to keep in step. It holds the intent key and the provider id, never an
-- address. Rejected: a status enum, and keying the intent on the e-mail address.

alter table form_submissions add column confirmed_at timestamptz;
-- The conditional update in `mailing.confirm` is the only write after insert.
grant update (confirmed_at) on form_submissions to mycel_app;

alter table supporters add column pending_lists text[] not null default '{}';

create table mail_sends (
  tenant_id     uuid not null references tenants(id),
  -- `<subscriber>:<event id>`: one message per subscriber per event.
  key           text not null,
  subscriber    text not null,
  event_id      uuid not null,
  attempted_at  timestamptz,
  sent_at       timestamptz,
  provider_id   text,
  last_error    text,
  created_at    timestamptz not null default now(),
  primary key (tenant_id, key)
);
alter table mail_sends enable row level security;
alter table mail_sends force row level security;
create policy tenant_isolation on mail_sends
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update on mail_sends to mycel_app;

-- Janitor: the one role allowed to delete expired rate-limit windows across tenants. Same shape
-- as mycel_worker (0003): nologin, entered with `set local role`, one table, one verb. The jobs
-- table (TODO #15) takes this over later; until then `startJanitor` in packages/db runs it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mycel_janitor') then
    create role mycel_janitor nologin;
  end if;
end $$;
grant mycel_janitor to current_user;
grant usage on schema public to mycel_janitor;
grant select, delete on rate_limits to mycel_janitor;
create policy janitor_sweep on rate_limits for delete to mycel_janitor using (true);
-- A delete policy cannot see rows without a select policy for the same role.
create policy janitor_read on rate_limits for select to mycel_janitor using (true);
