-- 0062: the old addresses of an item, kept when a published item gets a new slug.
-- An item that was published once keeps its old slug here when its address changes, and the
-- public router sends a request for that slug to the item's current path, in the same locale.
-- A row points at the item, not at a path: a chain of renames needs no flattening, a cycle cannot
-- be stored, and the target is whatever the item is published as at the moment of the request.
-- The slug stays held while the row exists (core refuses it to another item of the type), so a
-- new item cannot take over the address readers still follow; removing it is its own command.
--
-- Rejected: a path-to-path table with a status column (the brief's sketch). Paths repeat the
-- locale prefix and the `/articles` segment the slug already implies, every rename would rewrite
-- the earlier rows to the new end of the chain, and a status other than 301 has no user.

create table content_redirects (
  tenant_id   uuid not null references tenants(id),
  type        text not null check (type in ('page', 'article')),
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  item_id     uuid not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, type, slug),
  foreign key (tenant_id, item_id) references content_items (tenant_id, id)
);
-- The old addresses of one item, for the edit screen.
create index content_redirects_item on content_redirects (tenant_id, item_id);

alter table content_redirects enable row level security;
alter table content_redirects force row level security;
create policy tenant_isolation on content_redirects to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, delete on content_redirects to mycel_app;
