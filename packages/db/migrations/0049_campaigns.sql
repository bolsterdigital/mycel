-- Campaigns (ADR 033): a participation entity beside one landing page. The row holds what
-- the page cannot (kind, form, participation state and window, goal, archive) and no copy; the
-- page owns title, slug, publication and trash. Each landing page and each form belongs to at most
-- one campaign (unique keys; the use cases lock the item and the form first, so these keys are
-- the backstop, not the refusal). No delete grant: a campaign is archived, never deleted (rule 9).
--
-- `campaign_participations` is the confirmed, deduplicated fact per supporter (rule 7). The
-- confirmation path writes it; this migration gives it its shape, RLS, the insert an import
-- needs and its erasure: apply deletes an erased supporter's rows and adds the confirmed,
-- non-withdrawn ones to the campaign's anonymous `erased_count` in the same statement (rule 8).
-- The confirming submission is named without a foreign key: submissions end by retention (24
-- months) and by erasure, and a participation outlives its submission, or the count would drop.
--
-- Rejected: a third content type with its own revisions (ADR 033), participation in the
-- submissions table (a repost or a second confirmation would count twice), and a cascade from page
-- or form (nothing cascades over participation, rule 9).

alter table forms add unique (tenant_id, id);

create table campaigns (
  id                  uuid primary key,
  tenant_id           uuid not null references tenants(id),
  kind                text not null check (kind in ('petition', 'signup', 'fundraiser')),
  landing_item_id     uuid not null,
  form_id             uuid,
  participation_state text not null check (participation_state in ('draft', 'open', 'closed')),
  opens_at            timestamptz,
  closes_at           timestamptz,
  goal                jsonb,
  counter_visible     boolean not null default true,
  -- Confirmed participations of erased supporters, without any identifier (rule 8).
  erased_count        integer not null default 0 check (erased_count >= 0),
  archived_at         timestamptz,
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  unique (tenant_id, id),
  unique (tenant_id, landing_item_id),
  unique (tenant_id, form_id),
  check (opens_at is null or closes_at is null or opens_at < closes_at),
  -- An archived campaign takes no part (rule 9).
  check (archived_at is null or participation_state <> 'open'),
  foreign key (tenant_id, landing_item_id) references content_items (tenant_id, id),
  foreign key (tenant_id, form_id) references forms (tenant_id, id)
);
create index campaigns_list on campaigns (tenant_id, (archived_at is null), created_at desc, id);
alter table campaigns enable row level security;
alter table campaigns force row level security;
create policy tenant_isolation on campaigns to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on campaigns to mycel_app;

create table campaign_participations (
  tenant_id      uuid not null references tenants(id),
  campaign_id    uuid not null,
  supporter_id   uuid not null,
  submission_id  uuid not null,
  confirmed_at   timestamptz not null,
  withdrawn_at   timestamptz,
  primary key (tenant_id, campaign_id, supporter_id),
  check (withdrawn_at is null or withdrawn_at >= confirmed_at),
  foreign key (tenant_id, campaign_id) references campaigns (tenant_id, id),
  foreign key (tenant_id, supporter_id) references supporters (tenant_id, id)
);
-- A supporter's participations, for the erasure route and the supporter export.
create index campaign_participations_supporter on campaign_participations (tenant_id, supporter_id);
alter table campaign_participations enable row level security;
alter table campaign_participations force row level security;
create policy tenant_isolation on campaign_participations to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert on campaign_participations to mycel_app;

-- Erasure (ADR 019 rule 8, ADR 033 rule 8): the rows go, the count stays. mycel_erasure may
-- change only the count column of a campaign, never what it says.
grant select, delete on campaign_participations to mycel_erasure;
create policy erasure_apply on campaign_participations to mycel_erasure
  using (tenant_id = current_tenant_id());
grant select (id, tenant_id, erased_count), update (erased_count) on campaigns to mycel_erasure;
create policy erasure_apply on campaigns to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- A campaign card records a `campaign` reference (rule 4); archive reads it already.
alter table content_block_refs drop constraint content_block_refs_type_check;
alter table content_block_refs add constraint content_block_refs_type_check
  check (type in ('form', 'item', 'author', 'section', 'media', 'person', 'person_group', 'campaign'));
