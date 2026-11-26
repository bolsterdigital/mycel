-- MY-302, ADR 013 amendment of 2026-11-26: a site's own heading and body font, uploaded as
-- woff2 by the platform (`mycel fonts`), served from the site's own hostname. One family row per
-- role with the licence the uploader confirmed; one row per face (weight and style) with its
-- bytes. Rejected: the bytes in `site_settings` beside the wordmark (a family has up to eight
-- faces, and a settings read would carry them all).
create table site_fonts (
  tenant_id uuid not null references tenants(id) on delete cascade,
  role text not null check (role in ('heading', 'body')),
  family text not null check (length(family) between 1 and 100),
  category text not null check (category in ('sans', 'serif', 'slab')),
  licence_holder text not null check (length(licence_holder) between 1 and 200),
  licence_source text not null check (length(licence_source) between 1 and 200),
  licence_domains text[] not null check (cardinality(licence_domains) between 1 and 20),
  -- When the uploader confirmed that the licence allows self-hosting on these domains.
  licence_confirmed_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, role)
);

create table site_font_faces (
  tenant_id uuid not null,
  role text not null,
  weight integer not null check (weight between 100 and 900 and weight % 100 = 0),
  style text not null check (style in ('normal', 'italic')),
  bytes bytea not null check (octet_length(bytes) between 48 and 1048576),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  primary key (tenant_id, role, weight, style),
  foreign key (tenant_id, role) references site_fonts (tenant_id, role) on delete cascade
);

alter table site_fonts enable row level security;
alter table site_fonts force row level security;
create policy tenant_isolation on site_fonts to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update, delete on site_fonts to mycel_app;

alter table site_font_faces enable row level security;
alter table site_font_faces force row level security;
create policy tenant_isolation on site_font_faces to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update, delete on site_font_faces to mycel_app;
