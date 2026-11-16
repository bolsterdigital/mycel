-- Access tiers and standing grants (ADR 016 rule 2, ADR 019 rule 4). A tier is tenant data that
-- an article's `access.tierIds` and a supporter's grant point at by id. A grant is not a table:
-- `access.granted` and `access.revoked` are supporter events in `events` (append-only, ADR 003),
-- and `supporters.grants` is their fold, one standing grant per tier with its exclusive `until`
-- as a stored fact that `hasAccess` compares with the clock at each read. Rejected: a grants
-- table beside the log (a second source of truth that an erasure and a re-fold would both have to
-- keep in step) and an `expired` column written by a job (ADR 019 rejected alternatives).
--
-- No delete grant on access_tiers: a tier that vanishes would leave published access and standing
-- grants pointing at nothing. Slug and kind are fixed at create by the use case.
create table access_tiers (
  id           uuid primary key,
  tenant_id    uuid not null references tenants(id),
  slug         text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name         jsonb not null check (jsonb_typeof(name) = 'object'),
  description  jsonb check (description is null or jsonb_typeof(description) = 'object'),
  sort_order   integer not null default 0 check (sort_order between 0 and 10000),
  kind         text not null check (kind in ('free', 'paid')),
  created_at   timestamptz not null,
  updated_at   timestamptz not null,
  unique (tenant_id, slug),
  unique (tenant_id, id)
);
alter table access_tiers enable row level security;
alter table access_tiers force row level security;
create policy tenant_isolation on access_tiers to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on access_tiers to mycel_app;

alter table supporters
  add column grants jsonb not null default '[]'::jsonb check (jsonb_typeof(grants) = 'array');
-- Erasure empties the grants with the lists (ADR 019 rule 8): the erasure role updates named
-- columns only (0019), so the new one is named here.
grant update (grants) on supporters to mycel_erasure;
