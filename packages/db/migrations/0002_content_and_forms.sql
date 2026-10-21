-- 0002: pages, forms, submissions and rate-limit counters for the first vertical probe.
-- Every table is tenant-owned and follows the 0001 pattern: tenant_id, RLS enabled and forced,
-- the tenant_isolation policy, and grants to mycel_app limited to what the use cases need.

create table forms (
  id          uuid primary key,
  tenant_id   uuid not null references tenants(id),
  -- The definition is a validated document (ADR 010 rule 1); the core's Zod schema is the
  -- contract, so the database stores it whole instead of shredding it into columns.
  definition  jsonb not null,
  created_at  timestamptz not null default now()
);
create index forms_tenant on forms (tenant_id);
alter table forms enable row level security;
alter table forms force row level security;
create policy tenant_isolation on forms
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update on forms to mycel_app;

create table form_submissions (
  id          uuid primary key,
  tenant_id   uuid not null references tenants(id),
  form_id     uuid not null references forms(id),
  "values"    jsonb not null,
  locale      text not null,
  page_url    text,
  ip_hash     text,
  created_at  timestamptz not null
);
create index form_submissions_form on form_submissions (tenant_id, form_id, created_at);
alter table form_submissions enable row level security;
alter table form_submissions force row level security;
create policy tenant_isolation on form_submissions
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert on form_submissions to mycel_app;

create table pages (
  id              uuid primary key,
  tenant_id       uuid not null references tenants(id),
  slug            text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  default_locale  text not null,
  locales         text[] not null,
  title           jsonb not null,
  blocks          jsonb not null,
  created_at      timestamptz not null,
  updated_at      timestamptz not null,
  unique (tenant_id, slug)
);
alter table pages enable row level security;
alter table pages force row level security;
create policy tenant_isolation on pages
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update on pages to mycel_app;

-- Fixed-window counters (ADR 010 rule 5). Keys hold hashes, never addresses. Old windows are
-- garbage; a cleanup job is a follow-up (delete where window_start < now() - interval '1 day').
create table rate_limits (
  tenant_id     uuid not null references tenants(id),
  key           text not null,
  window_start  timestamptz not null,
  hits          integer not null default 0,
  primary key (tenant_id, key, window_start)
);
alter table rate_limits enable row level security;
alter table rate_limits force row level security;
create policy tenant_isolation on rate_limits
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update on rate_limits to mycel_app;
