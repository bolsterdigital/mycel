-- 0055: the site search index (TODO #42A; ADR 012 rule 7, ADR 018 rule 9).
--
-- `content_search` is a read model of what a site publishes for everyone: one row per locale
-- of an item whose published revision is public and indexable, holding the search tokens of that
-- revision in that locale and nothing a person can read. Core decides what a token is
-- (`searchTokens`, `searchEntry`), so the memory adapter and this table answer alike; the columns
-- are `tsvector`s built with `array_to_tsvector`, which applies no text search configuration,
-- and a question is a prefix `tsquery` over the same tokens.
--
-- The content repository writes and clears the rows where it writes the publication rows
-- (`save` and `insert`), so no caller can publish, unpublish or replace a revision without them.
-- A read still joins `content_item_locales.published_revision_id` and leaves the trash out: a row
-- that stayed behind can show nothing.
--
-- Rejected: `to_tsvector` with a configuration per locale (stemming the memory adapter cannot
-- reproduce, and a locale without a configuration would search differently), a row per revision
-- written on every save like `content_block_refs` (an index of every draft, of which only the
-- published one may ever match), and a backfill in SQL (it would be a second tokenizer in
-- PL/pgSQL; an item published before this migration enters the index at its next save or
-- publication, and #42A's second PR brings the rebuild).

create table content_search (
  tenant_id    uuid not null references tenants(id),
  item_id      uuid not null,
  revision_id  uuid not null,
  locale       text not null,
  -- The tokens of the title, which rank a hit first, and of title, lead and block texts.
  title        tsvector not null,
  body         tsvector not null,
  primary key (tenant_id, item_id, locale),
  foreign key (tenant_id, item_id, revision_id)
    references content_revisions (tenant_id, item_id, id)
);
create index content_search_body on content_search using gin (body);

alter table content_search enable row level security;
alter table content_search force row level security;
create policy tenant_isolation on content_search to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, delete on content_search to mycel_app;
