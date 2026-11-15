-- 0056: site navigation as one revisioned document per tenant (ADR 036).
--
-- `site_navigation` is the head of the aggregate: one row per tenant naming its latest revision.
-- `site_navigation_revisions` holds every saved document, immutable like `content_revisions`
-- (mycel_app may insert and read, nothing else); a restore copies an old document into a new
-- revision. `site_navigation_locales` points one revision per published locale, so a locale is
-- published exactly while its row exists. `site_navigation_refs` is the read model of the
-- content targets in a revision, one row per menu and item, written by the repository in the
-- transaction that inserts the revision (core's `navigationReferences`), so `content.item.delete`
-- can refuse an item the draft or a published revision points at (ADR 036 rule 9).
--
-- A revision stores no actor: who saved is in the audit log, so an operator's erasure
-- has no copy to reach here. B1 adds the tables beside the site chrome; the four chrome fields
-- move in a later migration (B2), once the menu editor exists.
--
-- Rejected: a revision table per menu with its own publication (a placement and its menu could go
-- live in different generations, ADR 036 rule 1), a jsonb column on `site_settings` (no
-- revisions, no references and the existing setter writes live), and deriving references with a
-- JSON path query at delete time (every revision's document read on every delete).

create table site_navigation_revisions (
  tenant_id         uuid not null references tenants(id),
  id                uuid not null,
  document          jsonb not null,
  -- The revision the caller read; null for the first save. Equal to the head's previous latest
  -- unless `merged` (ADR 026: a save on an older base, merged per menu and node).
  base_revision_id  uuid,
  merged            boolean not null default false,
  -- The older revision a restore copied.
  restored_from     uuid,
  created_at        timestamptz not null,
  primary key (tenant_id, id)
);

create table site_navigation (
  tenant_id           uuid primary key references tenants(id),
  latest_revision_id  uuid not null,
  updated_at          timestamptz not null,
  foreign key (tenant_id, latest_revision_id) references site_navigation_revisions (tenant_id, id)
);

create table site_navigation_locales (
  tenant_id     uuid not null references tenants(id),
  locale        text not null check (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  revision_id   uuid not null,
  published_at  timestamptz not null,
  primary key (tenant_id, locale),
  foreign key (tenant_id, revision_id) references site_navigation_revisions (tenant_id, id)
);

create table site_navigation_refs (
  tenant_id    uuid not null references tenants(id),
  revision_id  uuid not null,
  menu_id      text not null check (menu_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  item_id      uuid not null,
  primary key (tenant_id, revision_id, menu_id, item_id),
  foreign key (tenant_id, revision_id) references site_navigation_revisions (tenant_id, id)
);
-- "Which menus point at this item": the delete check.
create index site_navigation_refs_item on site_navigation_refs (tenant_id, item_id);

alter table site_navigation_revisions enable row level security;
alter table site_navigation_revisions force row level security;
create policy tenant_isolation on site_navigation_revisions to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert on site_navigation_revisions to mycel_app;

alter table site_navigation enable row level security;
alter table site_navigation force row level security;
create policy tenant_isolation on site_navigation to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update (latest_revision_id, updated_at) on site_navigation to mycel_app;

alter table site_navigation_locales enable row level security;
alter table site_navigation_locales force row level security;
create policy tenant_isolation on site_navigation_locales to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update (revision_id, published_at), delete on site_navigation_locales
  to mycel_app;

alter table site_navigation_refs enable row level security;
alter table site_navigation_refs force row level security;
create policy tenant_isolation on site_navigation_refs to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert on site_navigation_refs to mycel_app;
