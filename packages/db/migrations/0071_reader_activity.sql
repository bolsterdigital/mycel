-- 0071: reader activity is kept as little as the feature needs (ADR 019 rule 7). A reader's
-- `reader.signed_in` events stay for the tenant's `readerActivityDays` (in `site_settings.retention`,
-- default 90, 0 keeps none) and are then deleted by `retention.apply`; what remains is the
-- projection's `last_seen_at`, which the fold sets and a re-fold never moves back
-- (`refold` in core supporters/model.ts).
--
-- `mycel_retention` (0048) reads the events and projections of its tenant, and may delete only a
-- sign-in event whose supporter already holds it in `last_seen_at`. Whatever a statement asks, no
-- other event type and no sign-in that is not yet compacted can go; an erased supporter has no
-- `last_seen_at`, so its tombstoned events stay where the erasure left them.
--
-- Rejected: a compaction event written in place of the deleted ones (a second fact for one
-- timestamp that an erasure would also have to find), and deleting from the fronts' role
-- (`mycel_app` has no delete on the log, ADR 003).

alter table supporters add column last_seen_at timestamptz;
-- Erasure clears it with the lists and grants (ADR 019 rule 8); the erasure role updates named
-- columns only (0019).
grant update (last_seen_at) on supporters to mycel_erasure;

grant select (tenant_id, id, last_seen_at) on supporters to mycel_retention;
create policy retention_read on supporters for select to mycel_retention
  using (tenant_id = current_tenant_id());
grant select (tenant_id, id, supporter_id, type, occurred_at), delete on events to mycel_retention;
create policy retention_read on events for select to mycel_retention
  using (tenant_id = current_tenant_id());
create policy retention_apply on events for delete to mycel_retention
  using (
    tenant_id = current_tenant_id()
    and type = 'reader.signed_in'
    and exists (
      select 1 from supporters s
      where s.tenant_id = events.tenant_id
        and s.id = events.supporter_id
        and s.last_seen_at >= events.occurred_at
    )
  );
-- The retention scan: one tenant's sign-in events by age.
create index events_reader_signed_in on events (tenant_id, occurred_at)
  where type = 'reader.signed_in';
