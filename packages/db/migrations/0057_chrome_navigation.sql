-- 0057: the site chrome's menus move into the navigation document (ADR 036 rule 10, #107 B2).
--
-- `site_navigation_from_chrome(tenant, locales)` turns the four retired chrome fields into
-- menus: `navigation` becomes a menu placed in `main` with every top-level node in the bar,
-- `legal` a menu placed in `legal`, and `support` then `help` one footer column; none becomes a
-- call to action. Every label becomes an own label in every locale it has, every link a `url`
-- target; no URL is converted to a content target. Then it removes the four fields from the
-- chrome, so `site.chrome.update` (whose schema refuses them) and the public layout no longer see
-- them. A tenant without a navigation document gets revision 1, published in every locale of
-- the site; one that already has a document (the menu editor of #107 C predates this migration)
-- gets the migrated menus appended in a new draft revision on its latest, filling only the
-- placements that are still empty, and publishes nothing: its editors decide.
--
-- The migration calls the function for every tenant; the import calls it for an archive from
-- before this migration, whose `site_settings` row still carries the fields, so old exports stay
-- importable through the same mapping. Ids are `chrome-main`, `chrome-legal`, `chrome-footer` and
-- `chrome-main-1` and so on: valid navigation ids that the editor's random ids cannot collide with.
-- A label key that is not a locale is dropped (the chrome accepted any 2 to 12 characters).
-- No content target means no `site_navigation_refs` row.
--
-- Rejected: doing the mapping in TypeScript at import and in SQL here (two copies of rule 10 that
-- can drift), keeping the fields beside the menus until a later cleanup (the old setter would keep
-- writing live, which rule 10 forbids), and overwriting an existing document (an editor's menus
-- would be lost).

create function site_navigation_from_chrome(t uuid, site_locales text[]) returns boolean
language plpgsql as $$
declare
  c jsonb;
  grouped jsonb;
  main_nodes jsonb;
  legal_nodes jsonb;
  footer_nodes jsonb;
  menus jsonb := '[]'::jsonb;
  placements jsonb := '{"main": null, "actions": null, "footer": [], "legal": null}'::jsonb;
  head site_navigation%rowtype;
  revision uuid := gen_random_uuid();
  at timestamptz := now();
begin
  select chrome into c from site_settings where tenant_id = t;
  if c is null or not (c ?| array['navigation', 'legal', 'support', 'help']) then
    return false;
  end if;

  -- Every chrome link as a link node of its menu, in the chrome's order.
  with links (menu, pos, href, label) as (
    select 'main', x.pos, x.e->>'href', x.e->'label'
      from jsonb_array_elements(coalesce(c->'navigation', '[]'::jsonb)) with ordinality x(e, pos)
    union all
    select 'legal', x.pos, x.e->>'href', x.e->'label'
      from jsonb_array_elements(coalesce(c->'legal', '[]'::jsonb)) with ordinality x(e, pos)
    union all
    select 'footer', 1, c->'support'->>'href', c->'support'->'label'
     where jsonb_typeof(c->'support') = 'object'
    union all
    select 'footer', 2, c->'help'->>'href', c->'help'->'label'
     where jsonb_typeof(c->'help') = 'object'
  ), nodes as (
    select l.menu, l.pos,
           jsonb_build_object('id', 'chrome-' || l.menu || '-' || l.pos, 'kind', 'link',
                              'target', jsonb_build_object('kind', 'url', 'href', l.href))
           || case when labels.own = '{}'::jsonb then '{}'::jsonb
                   else jsonb_build_object('label', labels.own) end as node
      from links l,
           lateral (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) as own
                      from jsonb_each(coalesce(l.label, '{}'::jsonb)) as kv(k, v)
                     where k ~ '^[a-z]{2,3}(-[A-Z]{2})?$'
                       and jsonb_typeof(v) = 'string'
                       and btrim(v #>> '{}') <> '') labels
  )
  select coalesce(jsonb_object_agg(menu, list), '{}'::jsonb) into grouped
    from (select menu, jsonb_agg(node order by pos) as list from nodes group by menu) g;
  main_nodes := coalesce(grouped->'main', '[]'::jsonb);
  legal_nodes := coalesce(grouped->'legal', '[]'::jsonb);
  footer_nodes := coalesce(grouped->'footer', '[]'::jsonb);

  select * into head from site_navigation where tenant_id = t;
  if head.tenant_id is not null then
    select r.document->'menus', r.document->'placements' into menus, placements
      from site_navigation_revisions r
     where r.tenant_id = t and r.id = head.latest_revision_id;
  end if;

  if jsonb_array_length(main_nodes) > 0 then
    menus := menus || jsonb_build_array(jsonb_build_object(
      'id', 'chrome-main', 'name', 'Main menu', 'nodes', main_nodes));
    if placements->'main' = 'null'::jsonb then
      placements := jsonb_set(placements, '{main}', jsonb_build_object(
        'menuId', 'chrome-main',
        'bar', (select jsonb_agg(n->'id') from jsonb_array_elements(main_nodes) n)));
    end if;
  end if;
  if jsonb_array_length(legal_nodes) > 0 then
    menus := menus || jsonb_build_array(jsonb_build_object(
      'id', 'chrome-legal', 'name', 'Legal links', 'nodes', legal_nodes));
    if placements->'legal' = 'null'::jsonb then
      placements := jsonb_set(placements, '{legal}', jsonb_build_object('menuId', 'chrome-legal'));
    end if;
  end if;
  if jsonb_array_length(footer_nodes) > 0 then
    menus := menus || jsonb_build_array(jsonb_build_object(
      'id', 'chrome-footer', 'name', 'Support and help', 'nodes', footer_nodes));
    if jsonb_array_length(placements->'footer') < 4 then
      placements := jsonb_set(placements, '{footer}', (placements->'footer')
        || jsonb_build_array(jsonb_build_object('menuId', 'chrome-footer')));
    end if;
  end if;

  if grouped <> '{}'::jsonb then
    insert into site_navigation_revisions
      (tenant_id, id, document, base_revision_id, merged, restored_from, created_at)
      values (t, revision, jsonb_build_object('menus', menus, 'placements', placements),
              head.latest_revision_id, false, null, at);
    if head.tenant_id is not null then
      update site_navigation set latest_revision_id = revision, updated_at = at
       where tenant_id = t;
    else
      insert into site_navigation (tenant_id, latest_revision_id, updated_at)
        values (t, revision, at);
      insert into site_navigation_locales (tenant_id, locale, revision_id, published_at)
        select t, l, revision, at from unnest(site_locales) as l;
    end if;
  end if;

  update site_settings set chrome = chrome - 'navigation' - 'legal' - 'support' - 'help'
   where tenant_id = t;
  return true;
end;
$$;
-- The migrator (owner) and the import (as mycel_app, inside the imported tenant's context; RLS
-- keeps it to that tenant) call it; nobody else.
revoke execute on function site_navigation_from_chrome(uuid, text[]) from public;
grant execute on function site_navigation_from_chrome(uuid, text[]) to mycel_app;

-- backfill:begin
alter table site_settings no force row level security;
alter table site_navigation no force row level security;
alter table site_navigation_revisions no force row level security;
alter table site_navigation_locales no force row level security;
select site_navigation_from_chrome(s.tenant_id, tn.locales)
  from site_settings s join tenants tn on tn.id = s.tenant_id;
alter table site_navigation_locales force row level security;
alter table site_navigation_revisions force row level security;
alter table site_navigation force row level security;
alter table site_settings force row level security;
-- backfill:end
