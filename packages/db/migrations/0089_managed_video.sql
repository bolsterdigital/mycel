-- Editorial records and retained originals travel with the tenant. Bindings belong to this
-- installation and are recreated after import. A provider GUID copied from an archive could
-- otherwise address the exporting installation's library.
create table managed_videos (
  tenant_id uuid not null references tenants(id),
  id uuid not null,
  poster_id uuid not null,
  metadata jsonb not null,
  published_tracks jsonb not null default '{}',
  duration_seconds integer check (duration_seconds > 0),
  has_source boolean not null default false,
  created_at timestamptz not null,
  trashed_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, poster_id) references media(tenant_id, id)
);

create table managed_video_uploads (
  tenant_id uuid not null,
  video_id uuid not null,
  upload_key uuid not null,
  library_id text not null,
  provider_id uuid,
  mp4_height integer check (mp4_height > 0),
  state text not null check (state in
    ('reserved', 'creating', 'upload', 'encoding', 'ready', 'failed', 'over-limit')),
  storage_bytes bigint not null check (storage_bytes >= 0),
  duration_seconds integer not null check (duration_seconds >= 0),
  primary key (tenant_id, video_id),
  unique (tenant_id, upload_key),
  unique (tenant_id, provider_id),
  foreign key (tenant_id, video_id) references managed_videos(tenant_id, id)
);

alter table managed_videos enable row level security;
alter table managed_videos force row level security;
create policy tenant_isolation on managed_videos to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on managed_videos to mycel_app;

alter table managed_video_uploads enable row level security;
alter table managed_video_uploads force row level security;
create policy tenant_isolation on managed_video_uploads to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on managed_video_uploads to mycel_app;

alter table content_block_refs drop constraint content_block_refs_type_check;
alter table content_block_refs add constraint content_block_refs_type_check
  check (type in ('form', 'item', 'author', 'section', 'media', 'person', 'person_group',
    'campaign', 'video'));
