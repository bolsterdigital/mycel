-- 0011: content items, immutable revisions and publication per locale; authors, sections and
-- patterns; the probe's `pages` moved over and dropped (TODO #8a; ADR 012, 018, 020).
--
-- One `content_items` identity per page or article, every save a full document in
-- `content_revisions` (never updated: mycel_app may only insert and read them), and one row per
-- item and locale in `content_item_locales` holding the live pointer and the scheduled pin. Every
-- pointer is a composite foreign key on (tenant, item, revision), so a locale can only point at a
-- revision of its own item in its own tenant. The status is a generated column with the same
-- rule as `statusOf` in core/content/lifecycle.ts, so it cannot disagree with the pointers.
-- Rejected: draft and published documents in two tables (ADR 012 rule 4), one global published
-- revision for all locales (ADR 018 rule 9), and a status column that each write sets by hand.

create table content_items (
  id                  uuid primary key,
  tenant_id           uuid not null references tenants(id),
  type                text not null check (type in ('page', 'article')),
  slug                text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  -- The latest revision's title, so editorial lists need no revision reads.
  title               jsonb not null,
  default_locale      text not null,
  locales             text[] not null
                        check (cardinality(locales) between 1 and 10 and default_locale = any(locales)),
  latest_revision_id  uuid not null,
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  unique (tenant_id, type, slug),
  unique (tenant_id, id)
);

create table content_revisions (
  id          uuid primary key,  -- UUIDv7: ordering by id is ordering by save
  tenant_id   uuid not null references tenants(id),
  item_id     uuid not null,
  -- The whole validated document (core's ContentDocument), never a patch.
  document    jsonb not null,
  actor       jsonb not null,
  created_at  timestamptz not null,
  unique (tenant_id, item_id, id),
  foreign key (tenant_id, item_id) references content_items (tenant_id, id)
);
create index content_revisions_item on content_revisions (tenant_id, item_id, id desc);

-- An item and its first revision are inserted in one transaction; the check waits for commit.
alter table content_items add constraint content_items_latest_revision
  foreign key (tenant_id, id, latest_revision_id)
  references content_revisions (tenant_id, item_id, id)
  deferrable initially deferred;

create table content_item_locales (
  tenant_id              uuid not null references tenants(id),
  item_id                uuid not null,
  locale                 text not null,
  published_revision_id  uuid,
  published_at           timestamptz,
  first_published_at     timestamptz,
  scheduled_revision_id  uuid,
  scheduled_for          timestamptz,
  schedule_id            uuid,
  status                 text generated always as (
                           case when published_revision_id is not null then 'published'
                                when scheduled_revision_id is not null then 'scheduled'
                                when first_published_at is not null then 'unpublished'
                                else 'draft' end) stored,
  primary key (tenant_id, item_id, locale),
  foreign key (tenant_id, item_id) references content_items (tenant_id, id),
  foreign key (tenant_id, item_id, published_revision_id)
    references content_revisions (tenant_id, item_id, id),
  foreign key (tenant_id, item_id, scheduled_revision_id)
    references content_revisions (tenant_id, item_id, id),
  check ((published_revision_id is null) = (published_at is null)),
  check (published_revision_id is null or first_published_at is not null),
  check ((scheduled_revision_id is null) = (scheduled_for is null)
         and (scheduled_for is null) = (schedule_id is null))
);

create table authors (
  id          uuid primary key,
  tenant_id   uuid not null references tenants(id),
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text not null,
  bio         jsonb,
  image_id    uuid,
  links       jsonb not null default '[]',
  -- Internal: for the newsroom, never in a public representation (ADR 012 rule 2).
  email       text,
  created_at  timestamptz not null,
  updated_at  timestamptz not null,
  unique (tenant_id, slug)
);

create table sections (
  id           uuid primary key,
  tenant_id    uuid not null references tenants(id),
  slug         text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  title        jsonb not null,
  description  jsonb,
  sort_order   integer not null default 0,
  created_at   timestamptz not null,
  updated_at   timestamptz not null,
  unique (tenant_id, slug)
);

create table patterns (
  id             uuid primary key,
  tenant_id      uuid not null references tenants(id),
  name           jsonb not null,
  description    jsonb,
  intended_type  text not null check (intended_type in ('page', 'article')),
  blocks         jsonb not null,
  created_at     timestamptz not null,
  updated_at     timestamptz not null
);
create index patterns_tenant on patterns (tenant_id, id desc);

alter table content_items enable row level security;
alter table content_items force row level security;
create policy tenant_isolation on content_items
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update on content_items to mycel_app;

alter table content_revisions enable row level security;
alter table content_revisions force row level security;
create policy tenant_isolation on content_revisions
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
-- Immutable: a revision is written once and read forever after.
grant select, insert on content_revisions to mycel_app;

alter table content_item_locales enable row level security;
alter table content_item_locales force row level security;
create policy tenant_isolation on content_item_locales
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
-- Delete: a draft locale removed from the document loses its row (never a published one, core).
grant select, insert, update, delete on content_item_locales to mycel_app;

alter table authors enable row level security;
alter table authors force row level security;
create policy tenant_isolation on authors
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update on authors to mycel_app;

alter table sections enable row level security;
alter table sections force row level security;
create policy tenant_isolation on sections
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update on sections to mycel_app;

alter table patterns enable row level security;
alter table patterns force row level security;
create policy tenant_isolation on patterns
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update on patterns to mycel_app;

-- The probe's pages move into content_items once, in this transaction. Each page keeps its id,
-- slug, times and blocks, gets a first revision and deterministic block ids (md5 of page id and
-- position, so a re-run of this conversion on the same data assigns the same ids), and is
-- published only in the locales where every field the old renderer showed actually has a value:
-- the probe fell back to the default locale silently, and a missing translation must not turn
-- into a publication of its own. Every row is validated here, in SQL, against the shape core's
-- schema accepts; a row that does not fit stops the migration with its page id and the reason,
-- and the whole transaction (tables included) rolls back. Forced RLS binds the schema owner too,
-- so the tenant context is set per tenant: this runs as a non-superuser owner.
-- packages/db/src/content-migration.conformance.test.ts runs the block between the markers.

-- backfill:begin
do $$
declare
  t record;
  p record;
  b record;
  loc text;
  blocks jsonb;
  rev uuid;
  ms bigint;
  noise text;
  complete boolean;
  fail text;
begin
  for t in select id from tenants order by id loop
    perform set_config('app.tenant_id', t.id::text, true);
    for p in select * from pages where tenant_id = t.id order by id loop
      fail := null;
      if exists (select 1 from unnest(p.locales) l where l !~ '^[a-z]{2,3}(-[A-Z]{2})?$')
         or cardinality(p.locales) not between 1 and 10
         or (select count(distinct l) from unnest(p.locales) l) <> cardinality(p.locales) then
        fail := 'locales must be 1 to 10 distinct locale codes';
      elsif not (p.default_locale = any(p.locales)) then
        fail := 'default_locale is not one of locales';
      elsif jsonb_typeof(p.title) <> 'object' or not p.title ? p.default_locale then
        fail := 'title has no value in the default locale';
      elsif exists (select 1 from jsonb_each(p.title) e
                    where not (e.key = any(p.locales)) or jsonb_typeof(e.value) <> 'string'
                       or length(e.value #>> '{}') not between 1 and 200) then
        fail := 'title has a value outside locales or of the wrong shape';
      elsif jsonb_typeof(p.blocks) <> 'array' or jsonb_array_length(p.blocks) > 200 then
        fail := 'blocks is not an array of at most 200 blocks';
      end if;

      blocks := '[]'::jsonb;
      if fail is null then
        for b in select value, ordinality from jsonb_array_elements(p.blocks) with ordinality loop
          if b.value->>'type' = 'heading' then
            if b.value - 'type' - 'version' - 'props' <> '{}'::jsonb
               or b.value->'version' <> '1'::jsonb
               or (b.value->'props') - 'text' <> '{}'::jsonb
               or jsonb_typeof(b.value#>'{props,text}') <> 'object'
               or b.value#>'{props,text}' = '{}'::jsonb
               or exists (select 1 from jsonb_each(b.value#>'{props,text}') e
                          where not (e.key = any(p.locales)) or jsonb_typeof(e.value) <> 'string'
                             or length(e.value #>> '{}') not between 1 and 200) then
              fail := format('block %s is not a valid heading', b.ordinality);
            end if;
          elsif b.value->>'type' = 'signup-form' then
            if b.value - 'type' - 'version' - 'props' <> '{}'::jsonb
               or b.value->'version' <> '1'::jsonb
               or (b.value->'props') - 'formId' <> '{}'::jsonb
               or b.value#>>'{props,formId}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               or not exists (select 1 from forms f
                              where f.id::text = b.value#>>'{props,formId}' and f.tenant_id = t.id) then
              fail := format('block %s references no form of this tenant', b.ordinality);
            end if;
          else
            fail := format('block %s has unknown type %s', b.ordinality, coalesce(b.value->>'type', 'null'));
          end if;
          exit when fail is not null;
          blocks := blocks || jsonb_build_array(jsonb_build_object(
            'id', md5(p.id::text || ':' || b.ordinality)::uuid::text,
            'type', b.value->'type', 'version', 1, 'props', b.value->'props'));
        end loop;
      end if;
      if fail is not null then
        raise exception 'page % (tenant %, slug %) cannot be migrated: %. Fix or remove the row, then migrate again.',
          p.id, t.id, p.slug, fail;
      end if;

      -- A UUIDv7 at the page's last change, so the revision sorts where it belongs.
      ms := floor(extract(epoch from p.updated_at) * 1000)::bigint;
      noise := md5(p.id::text || clock_timestamp()::text || random()::text);
      rev := (lpad(to_hex(ms), 12, '0') || '7' || substr(noise, 1, 3) || '8'
              || substr(noise, 4, 15))::uuid;

      insert into content_items
        (id, tenant_id, type, slug, title, default_locale, locales, latest_revision_id,
         created_at, updated_at)
      values
        (p.id, t.id, 'page', p.slug, p.title, p.default_locale, p.locales, rev,
         p.created_at, p.updated_at);
      insert into content_revisions (id, tenant_id, item_id, document, actor, created_at)
      values (rev, t.id, p.id,
              jsonb_build_object(
                'type', 'page', 'title', p.title, 'defaultLocale', p.default_locale,
                'locales', to_jsonb(p.locales), 'blocks', blocks,
                'seo', jsonb_build_object('noindex', false),
                'access', jsonb_build_object('level', 'public', 'teaser', 'lead')),
              '{"kind": "system", "job": "migration:0011"}'::jsonb, p.updated_at);

      foreach loc in array p.locales loop
        complete := p.title ? loc and not exists (
          select 1 from jsonb_array_elements(blocks) x
          where x->>'type' = 'heading' and not (x#>'{props,text}') ? loc);
        insert into content_item_locales
          (tenant_id, item_id, locale, published_revision_id, published_at, first_published_at)
        values
          (t.id, p.id, loc,
           case when complete then rev end,
           case when complete then p.updated_at end,
           case when complete then p.updated_at end);
      end loop;
    end loop;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
-- backfill:end

drop table pages;
