-- 0039: a trash for pages and articles (ADR 030). `deleted_at` marks an item as
-- deleted; every revision, publication row and reference stays, so a deletion can be undone and
-- nothing is lost here. The slug key moves to the items outside the trash: a deleted item must not
-- hold its address, and restoring one onto a taken slug is decided in core (it gets a free one).
-- The index keeps the constraint's name, because the adapter recognises a taken slug by it.
-- Rejected: a separate trash table (revisions, locales and references carry composite keys to
-- content_items), and renaming the slug on delete (a restore could not give the address back).

alter table content_items add column deleted_at timestamptz;

alter table content_items drop constraint content_items_tenant_id_type_slug_key;
create unique index content_items_tenant_id_type_slug_key
  on content_items (tenant_id, type, slug)
  where deleted_at is null;

create index content_items_trash on content_items (tenant_id, deleted_at desc, id desc)
  where deleted_at is not null;
