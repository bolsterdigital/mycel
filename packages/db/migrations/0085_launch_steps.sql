-- 0085 (MY-262, ADR 037): the launch checklist's stored half. The steps themselves are a register
-- in code (`core/launch/steps.ts`); a site keeps one row per step it has touched, holding only
-- what a person decided: ticked, a warning accepted, a note, another owner, switched off or on.
-- A check's outcome is never stored, it is evaluated on every read. No operator id: who changed
-- a step is in the audit row the command writes, so operator erasure (ADR 035) has nothing to
-- find here. A row for a step the register no longer has is ignored on read, never an error.
--
-- Rejected: one JSON document per site (two administrators ticking different steps would
-- overwrite each other), and a foreign key to a step table (the register lives in code).
create table launch_steps (
  tenant_id     uuid not null references tenants(id),
  step_id       text not null check (step_id ~ '^[a-z][a-z0-9-]{1,63}$'),
  done          boolean not null default false,
  acknowledged  boolean not null default false,
  applicable    boolean,
  owner         text check (owner in ('platform', 'organisation', 'shared')),
  note          text not null default '' check (char_length(note) <= 1000),
  updated_at    timestamptz not null,
  primary key (tenant_id, step_id)
);

alter table launch_steps enable row level security;
alter table launch_steps force row level security;
create policy tenant_isolation on launch_steps to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update (done, acknowledged, applicable, owner, note, updated_at)
  on launch_steps to mycel_app;
