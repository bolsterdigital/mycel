-- 0012: the media register (TODO #10; ADR 004 rules 4 and 6, ADR 015 rule 6, ADR 018 rule 7,
-- ADR 019 rule 6). One row per uploaded file; the bytes live in the BlobStore under
-- `tenants/<tenant id>/media/<media id>/`, never in Postgres. Rejected: a `media_variants` table
-- (variants are derived and only exist together, so they are one jsonb column of the asset) and
-- bytea columns (a 25 MB file per row bloats every backup and vacuum, and a bucket is the
-- commodity ADR 008 picks for this).
--
-- `total_bytes` is the original plus every variant: what `media.storage_max_bytes` counts
-- (`usage.storageBytes`). A soft-deleted row (`deleted_at`) no longer counts and is invisible to
-- the use cases; it stays until the `media.purge` job has removed its files, so nothing points at
-- a file that is gone and no file outlives its row longer than one job.
--
-- Alt text and "decorative" are not columns: they belong to the use of an image in a block, not
-- to the file (fundamentcheck 2026-10-21). Both tables are tenant data under forced RLS, with
-- `tenant_isolation` bound to mycel_app as 0010 did for `tenant_hostnames` (the role that works
-- under a tenant context; the orphan sweep reads per tenant through it, never across tenants).

create table media (
  id            uuid primary key,
  tenant_id     uuid not null references tenants(id),
  kind          text not null check (kind in ('image', 'document')),
  content_type  text not null check (content_type in
                  ('image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif',
                   'application/pdf')),
  filename      text not null check (char_length(filename) between 1 and 200),
  checksum      text not null check (checksum ~ '^[0-9a-f]{64}$'),
  size_bytes    bigint not null check (size_bytes >= 0),
  total_bytes   bigint not null check (total_bytes >= size_bytes),
  width         integer check (width > 0),
  height        integer check (height > 0),
  -- [{ name, format, width, height, bytes }], see `StoredVariant` in core.
  variants      jsonb not null default '[]' check (jsonb_typeof(variants) = 'array'),
  access        text not null default 'public' check (access in ('public', 'restricted')),
  -- Localised, may be empty.
  caption       jsonb not null default '{}' check (jsonb_typeof(caption) = 'object'),
  -- { work: { title, maker } | null, photographer: string | null }: two credits, not one.
  credit        jsonb not null default '{"work": null, "photographer": null}'
                  check (jsonb_typeof(credit) = 'object'),
  source        text check (char_length(source) <= 500),
  licence       text check (char_length(licence) <= 100),
  focal         jsonb not null default '{"x": 0.5, "y": 0.5}' check (jsonb_typeof(focal) = 'object'),
  state         text not null default 'ready' check (state in ('ready', 'failed')),
  -- The actor (ADR 009 rule 9).
  created_by    jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  -- `media_usages` references (tenant_id, id), so a usage can never cross tenants.
  unique (tenant_id, id)
);
create index media_tenant_created on media (tenant_id, created_at desc, id desc);

alter table media enable row level security;
alter table media force row level security;
create policy tenant_isolation on media to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update, delete on media to mycel_app;

-- Live references (ADR 004 rule 6): `media.delete` refuses while any row points at the asset.
-- `ref` is opaque to this module (`item:<id>:rev:<id>`, `og:<...>`); #8b1 replaces the rows of
-- one ref when it saves a block tree, in its own transaction.
create table media_usages (
  tenant_id  uuid not null references tenants(id),
  media_id   uuid not null,
  ref        text not null check (char_length(ref) between 1 and 300),
  block_id   text not null check (char_length(block_id) between 1 and 100),
  primary key (tenant_id, media_id, ref, block_id),
  foreign key (tenant_id, media_id) references media (tenant_id, id)
);
create index media_usages_ref on media_usages (tenant_id, ref);

alter table media_usages enable row level security;
alter table media_usages force row level security;
create policy tenant_isolation on media_usages to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, delete on media_usages to mycel_app;
