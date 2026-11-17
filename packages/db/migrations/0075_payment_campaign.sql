-- A payment names the fundraiser it was given to (ADR 033 rule 8, amendment 2026-11-17, brief
-- MY-252 PR 4). A donation form bound to a fundraiser opens its payment with the campaign's id,
-- and the fundraiser's counter is the sum of its paid payments. A refunded or charged-back
-- payment leaves `paid`, so it drops out of the sum by its status alone.
--
-- On the payment, not reached through its submission: an erasure or the retention of submissions
-- clears `submission_id`, and the counter must not fall when a donor is erased (rule 8). The
-- campaign id names no person, so an erasure leaves it standing with the amount. Campaigns are
-- archived, never deleted (rule 9), so the reference needs no delete action.
--
-- Rejected: a running total on the campaign row (a second number beside the ledger that a missed
-- step or a replay would make wrong; the sum is rebuilt from the payments every time) and
-- participation rows for donors (a gift is no confirmed signature; there is nothing to withdraw).
alter table payments add column campaign_id uuid;
alter table payments add constraint payments_campaign
  foreign key (tenant_id, campaign_id) references campaigns (tenant_id, id);
-- What a fundraiser's counter sums: its paid payments.
create index payments_campaign_paid on payments (tenant_id, campaign_id)
  where campaign_id is not null and status = 'paid';
