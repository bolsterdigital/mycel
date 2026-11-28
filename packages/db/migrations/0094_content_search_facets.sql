-- 0094: the facets of the site search (MY-308 PR 2, brief search-page § PR 2).
--
-- A visitor filters search results by kind (page, article, Video/audio), section and period,
-- and sees how many hits each kind and section holds. Kind and section are revision data: the
-- section an article names and its presentation profile (`media` is a Video/audio article)
-- live in the document, so the index row of a published revision carries them beside its
-- tokens. Core decides both values (`searchEntry`); the row is written where the tokens are.
-- The type and the publication date come from `content_items` and `content_item_locales`, which
-- the search joins already, so they are not copied.
--
-- `section_id` is the id the revision names, without a foreign key: a revision is immutable and
-- may name a section that was removed later, as the published document itself does; the search
-- resolves the id and leaves an unknown one out of the facets. `profile` is the article's
-- presentation profile, null for a page and for an article that never chose one.
--
-- Backfill: the existing rows take both values from their published revision, in SQL. That is
-- two JSON paths, not a second tokenizer (the reason 0055 had no backfill), and a row whose
-- revision is no article keeps nulls, which is what core writes for it. The owner running the
-- migration has no policy of its own, so forced RLS is lifted for the update alone, as in 0057
-- and 0058; both tables carry `tenant_id` and the join keeps every row in its tenant.
--
-- Rejected: a `kind` column (a derived value that a fourth profile would have to rewrite), and
-- reading kind and section from the revision at query time (a JSON read per candidate row for
-- every count, on every search).

alter table content_search
  add column section_id uuid,
  add column profile text;

-- backfill:begin
alter table content_search no force row level security;
alter table content_revisions no force row level security;
update content_search s
set section_id = (r.document ->> 'sectionId')::uuid,
    profile = r.document -> 'presentation' ->> 'profile'
from content_revisions r
where r.tenant_id = s.tenant_id
  and r.id = s.revision_id
  and r.document ->> 'type' = 'article';
alter table content_search force row level security;
alter table content_revisions force row level security;
-- backfill:end
