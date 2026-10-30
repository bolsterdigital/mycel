-- What a backup snapshot must hold (TODO #29A, ADR 019 rule 8), read by backup.sh before the dump:
-- the database's clock as `t0`, then one row per file of every live media asset, as `<media id>
-- <blob key>`. The keys follow `mediaKeys` in packages/core/src/media/model.ts: the private
-- original `original.<extension>` unless a variant is named `file`, and `<name>.<extension>` per
-- variant, the extensions from FORMAT_OF and EXTENSION_OF. An unknown content type or format
-- gives a name no file has, so the backup fails rather than skip it. The `media keys` test in
-- packages/db/src/media.test.ts runs this file and holds it to `mediaKeys`.
-- Rejected: a count of files per asset (an unexpected file in the folder hid a missing original,
-- with the same count) and a node step in the backup image (Alpine without node, on purpose).
select 't0' as id, extract(epoch from now())::bigint::text as key
union all
select m.id::text, 'tenants/' || m.tenant_id || '/media/' || m.id || '/' || f.file
from media m
cross join lateral (
  select 'original.' || case m.content_type
      when 'image/jpeg' then 'jpg'
      when 'image/png' then 'png'
      when 'image/webp' then 'webp'
      when 'image/avif' then 'avif'
      when 'image/gif' then 'gif'
      when 'application/pdf' then 'pdf'
      else 'unknown-content-type'
    end as file
  where not m.variants @> '[{"name": "file"}]'
  union all
  select (v ->> 'name') || '.' || case v ->> 'format'
      when 'jpeg' then 'jpg'
      when 'png' then 'png'
      when 'webp' then 'webp'
      when 'avif' then 'avif'
      when 'gif' then 'gif'
      when 'pdf' then 'pdf'
      else 'unknown-format'
    end
  from jsonb_array_elements(m.variants) v
) f
where m.deleted_at is null;
