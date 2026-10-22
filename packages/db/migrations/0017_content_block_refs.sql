-- 0017: block discovery and live references (TODO #8b1; ADR 020 rule 7, ADR 004 rule 6).
--
-- `content_block_refs` is a read model derived from a revision's document: one row per block and
-- target (a signup block's form, an item a link mark points at, media once #8b2 brings `image`),
-- plus a row with a null block id for each author and the section of an article. The content
-- repository writes the rows in the transaction that inserts the revision, derived from the
-- document there (core's `documentReferences`), so no caller can save a revision without them.
-- Like revisions they are immutable: mycel_app may insert and read, nothing else. Live usage is
-- the join with `content_item_locales.published_revision_id`, never "every revision".
--
-- The GIN `jsonb_path_ops` index on `content_revisions.document` serves the block-type filter of
-- `content.item.find` (`document @> '{"blocks": [{"type": ...}]}'`). Rejected: a second datastore
-- or search adapter (ADR 008, no measured need), a `block_type` column per block (the index
-- answers the containment query without a second copy of the tree), and refs kept by triggers
-- (a trigger would duplicate the reference walk in PL/pgSQL for every future block type).

create table content_block_refs (
  tenant_id    uuid not null references tenants(id),
  item_id      uuid not null,
  revision_id  uuid not null,
  -- Null: the document references it (an article's authors and section), not a block.
  block_id     text check (block_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  type         text not null check (type in ('form', 'item', 'author', 'section', 'media')),
  ref_id       uuid not null,
  foreign key (tenant_id, item_id, revision_id)
    references content_revisions (tenant_id, item_id, id)
);
-- "Who uses X": the reverse lookup of find, liveReferences and a delete check.
create index content_block_refs_target on content_block_refs (tenant_id, type, ref_id, revision_id);
-- The matching rows of one revision, for find's block ids.
create index content_block_refs_revision on content_block_refs (tenant_id, revision_id);

create index content_revisions_document on content_revisions using gin (document jsonb_path_ops);

alter table content_block_refs enable row level security;
alter table content_block_refs force row level security;
-- Not `to mycel_app` like 0012: the backfill below runs as the schema owner, which a policy bound
-- to mycel_app would shut out. #20 binds every content table's policy in one go.
create policy tenant_isolation on content_block_refs
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert on content_block_refs to mycel_app;

-- Every revision that exists before this migration gets its rows once, per tenant under its own
-- context (forced RLS binds the schema owner too, so this runs as a non-superuser owner). The
-- walk is the SQL twin of `documentReferences`: signup blocks, `link` marks with an `itemId`
-- anywhere inside a rich-text block (strict `.**`, so arrays are not unwrapped into duplicate
-- matches), and an article's `authorIds` and `sectionId`. `distinct` folds a block that links
-- one item twice into one row, as the repository does.
-- packages/db/src/content-refs-migration.conformance.test.ts runs the block between the markers.

-- backfill:begin
do $$
declare
  t record;
begin
  for t in select id from tenants order by id loop
    perform set_config('app.tenant_id', t.id::text, true);
    insert into content_block_refs (tenant_id, item_id, revision_id, block_id, type, ref_id)
    select distinct r.tenant_id, r.item_id, r.id, x.block_id, x.type, x.ref_id::uuid
    from content_revisions r
    cross join lateral (
      select b->>'id' as block_id, 'form' as type, b#>>'{props,formId}' as ref_id
      from jsonb_array_elements(r.document->'blocks') b
      where b->>'type' = 'signup-form'
      union all
      select b->>'id', 'item', l #>> '{}'
      from jsonb_array_elements(r.document->'blocks') b,
           jsonb_path_query(b->'props'->'content',
             'strict $.** ? (@.type == "link" && exists(@.attrs.itemId)).attrs.itemId') l
      where b->>'type' = 'rich-text'
      union all
      select null, 'author', a
      from jsonb_array_elements_text(
             case when r.document->>'type' = 'article'
                  then coalesce(r.document->'authorIds', '[]') else '[]' end) a
      union all
      select null, 'section', r.document->>'sectionId'
      where r.document->>'type' = 'article' and jsonb_typeof(r.document->'sectionId') = 'string'
    ) x
    where r.tenant_id = t.id;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
-- backfill:end
