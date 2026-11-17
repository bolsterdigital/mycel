-- 0073: restricted revisions in the site search index (ADR 016 rule 3, ADR 018 rule 9, brief
-- site-search § B).
--
-- Until now `content_search` held a row only for a public revision, so a signed-in reader could
-- not find the articles they signed in for. A restricted revision now gets a row too, with two
-- token sets and the access it asks for:
--
--   - `body`: every token, as before; matched only where the asking reader has access;
--   - `teaser`: the tokens of the teaser document (title, lead and the blocks before the
--     boundary, what the item's own address shows everyone); null for a public revision, whose
--     `body` is for everyone;
--   - `access_level` and `tier_ids`: the revision's `access`. A revision is immutable, so these
--     never go stale; whether a reader's grant stands is decided at the read, never stored
--     (ADR 019 rule 4).
--
-- Core decides the tokens (`searchEntry`) and the rule (`searchOpens`); the adapter states the rule
-- once more in SQL and the adapter rules compare it with the memory adapter. The table is a read
-- model: the existing rows are public ones and stay valid as they are, and a restricted item
-- published before this migration enters the index at its next publication or at
-- `mycel search rebuild`. No data is lost either way.
--
-- Rejected: a second table for restricted rows (two queries to merge in one order and one page),
-- and storing the teaser for public rows as well (a second copy of every public body's tokens).

alter table content_search
  add column teaser tsvector,
  add column access_level text not null default 'public'
    check (access_level in ('public', 'members', 'tier')),
  add column tier_ids uuid[] not null default '{}',
  add constraint content_search_teaser check ((access_level = 'public') = (teaser is null));
alter table content_search alter column access_level drop default;
alter table content_search alter column tier_ids drop default;
