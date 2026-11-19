-- 0082 (MY-258, ADR 010 rule 10): welcome series, the first automation. A series belongs to one
-- list (`mail_automations`, one per list per tenant) and has one to five steps, each an item of
-- the site sent so many days after a person joined that list (`mail_automation_steps`). A run
-- (`mail_automation_runs`) is one person in one series: when they joined and the last step
-- position handled. Its primary key makes a series start once per person, so leaving the list
-- and joining again does not start it over; the step job moves `through` in the transaction
-- that publishes the step, so a job that runs twice sends once.
--
-- All three are tenant data under forced RLS and `mycel_app` has the grants: the trigger and the
-- step job run as tenant work (ADR 011 rule 3). The one background grant is `mycel_erasure`'s
-- delete on runs, the same route as for campaign participations (0049). A step names its
-- item without a foreign key: an item in the trash or purged makes the step skip, it never blocks
-- the purge. A run names its supporter by id only, never an address.
--
-- Rejected: steps as a JSON column on the series (a step's bounds would rest on the code alone),
-- and a run per step (the series' one position per person says the same with one row).
create table mail_automations (
  tenant_id   uuid not null references tenants(id),
  id          uuid not null,
  list        text not null check (list ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  enabled     boolean not null default false,
  created_at  timestamptz not null,
  updated_at  timestamptz not null,
  primary key (tenant_id, id),
  unique (tenant_id, list)
);

create table mail_automation_steps (
  tenant_id      uuid not null,
  automation_id  uuid not null,
  position       smallint not null check (position between 0 and 4),
  item_id        uuid not null,
  delay_days     smallint not null check (delay_days between 0 and 60),
  primary key (tenant_id, automation_id, position),
  unique (tenant_id, automation_id, delay_days),
  foreign key (tenant_id, automation_id)
    references mail_automations (tenant_id, id) on delete cascade
);

create table mail_automation_runs (
  tenant_id      uuid not null,
  automation_id  uuid not null,
  supporter_id   uuid not null,
  started_at     timestamptz not null,
  through        smallint not null default -1 check (through between -1 and 4),
  primary key (tenant_id, automation_id, supporter_id),
  foreign key (tenant_id, automation_id)
    references mail_automations (tenant_id, id) on delete cascade
);
create index mail_automation_runs_supporter on mail_automation_runs (tenant_id, supporter_id);

alter table mail_automations enable row level security;
alter table mail_automations force row level security;
create policy tenant_isolation on mail_automations to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update (enabled, updated_at) on mail_automations to mycel_app;

alter table mail_automation_steps enable row level security;
alter table mail_automation_steps force row level security;
create policy tenant_isolation on mail_automation_steps to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, delete on mail_automation_steps to mycel_app;

alter table mail_automation_runs enable row level security;
alter table mail_automation_runs force row level security;
create policy tenant_isolation on mail_automation_runs to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update (through), delete on mail_automation_runs to mycel_app;

-- An erasure deletes the erased supporter's runs, as it does their participations (0049).
grant select, delete on mail_automation_runs to mycel_erasure;
create policy erasure_apply on mail_automation_runs to mycel_erasure
  using (tenant_id = current_tenant_id());
