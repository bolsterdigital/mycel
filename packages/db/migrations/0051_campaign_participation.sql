-- Participation writes (ADR 033 rule 7, #47 B2). 0049 let the app insert a participation; this
-- lets it record a withdrawal and a renewed signature on the same row, which is all a use case
-- may change: never the campaign or the supporter the row belongs to, and never a delete, which
-- only the erasure does (rule 8). Rejected: a new row per signature with the old one kept, which
-- would make "one per supporter" a query instead of the primary key.

grant update (submission_id, confirmed_at, withdrawn_at) on campaign_participations to mycel_app;

-- The public count is active rows plus `erased_count`; the partial index keeps that a cheap read
-- as a campaign grows.
create index campaign_participations_active on campaign_participations (tenant_id, campaign_id)
  where withdrawn_at is null;
