-- A paid access tier can be bought as a membership (ADR 005 rule 8, ADR 016 rule 2, brief MY-254
-- PR 4, choice 9). Its price is tenant data on the tier: an amount per interval in minor units,
-- with a version that goes up whenever a price changes, so a subscription records which price it
-- pays (`subscriptions.price_version`, 0077) and a later change does not touch running members.
-- `signup_path` is the site path of the page where a visitor becomes a member; the prompt on a
-- restricted article links there.
--
-- A membership's period gives access through the existing grant: `access.granted` with the new
-- kind `paid` is a supporter event, and the kinds of a grant are not a column anywhere, so no
-- change is needed for it here.
--
-- Rejected: a prices table with a row per interval and version (a history nobody reads: the
-- ledger already holds the amount of every period), and the signup page as a content id (the
-- prompt would need the published address of another item in every locale; picking a page from
-- the content list is a note).
alter table access_tiers
  add column prices jsonb not null default '{}'::jsonb
    check (jsonb_typeof(prices) = 'object'),
  add column price_version integer not null default 1 check (price_version >= 1),
  add column signup_path text
    check (signup_path is null or signup_path ~ '^/[a-z0-9/_-]{0,199}$'),
  -- Only a paid tier has prices.
  add constraint access_tiers_prices_paid check (kind = 'paid' or prices = '{}'::jsonb);
