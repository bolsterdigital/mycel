-- This projection can be rebuilt from published links. Editorial data stays in revisions.
create table social_conversation_counts (
  tenant_id uuid not null references tenants(id) on delete cascade,
  network text not null check (network in ('bluesky', 'mastodon')),
  post_key text not null,
  checked_at timestamptz not null,
  expires_at timestamptz,
  replies integer check (replies >= 0),
  reposts integer check (reposts >= 0),
  primary key (tenant_id, network, post_key)
);

alter table social_conversation_counts enable row level security;
alter table social_conversation_counts force row level security;
create policy tenant_isolation on social_conversation_counts to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update, delete on social_conversation_counts to mycel_app;
