-- MY-288 PR B: a petition or signup may start from an earlier count, a paper petition or the total
-- an older site showed (ADR 033 rule 8, amendment 2026-11-22). A fixed number on the campaign,
-- added to the public count and set, never incremented, so a repeated import writes the same
-- value and doubles nothing. It stays apart from `campaign_participations` and from
-- `erased_count`: no supporter, no confirmation, no consent. A fundraiser has none, because its
-- count is money from the ledger and a free correction would be a gift nobody paid.
-- Rejected: synthetic participation rows (people who never confirmed, in every supporter export)
-- and a correction on the goal (it would move the bar without saying why).
alter table campaigns
  add column starting_count integer not null default 0
    check (starting_count >= 0 and starting_count <= 100000000),
  add constraint campaigns_fundraiser_no_starting_count
    check (kind <> 'fundraiser' or starting_count = 0);
