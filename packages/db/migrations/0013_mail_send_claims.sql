-- 0013: an exclusive attempt claim on mail intents, and what reconciliation counts with (brief
-- #22C; ADR 019 rule 6, ADR 011 rule 1).
--
-- An attempt is now a claim in one conditional upsert (`mailSendsRepository.claim`): it takes
-- the row only when it is not sent, not abandoned, its lease has expired and `attempted_at` is
-- still what the caller read, so of two simultaneous callers exactly one gets a row back.
-- `claimed_until` is the lease, `attempts` counts claims, `abandoned_at` marks an intent given
-- up. `correlation` is `sha256(tenant id, lower(recipient), subject)` in hex: the intents a
-- provider listing cannot tell apart share it, and reconciliation counts them. It is a hash,
-- never the address, so the table still holds no address (and a later erasure can find a
-- supporter's rows by recomputing it, ADR 019 rule 8). State stays derived from the timestamps,
-- no status column (0006); docs/reference/mail.md has the five states as SQL.
-- Rejected: an advisory lock per key (it does not outlive the three transactions of a send) and
-- `select ... for update` (the row does not exist before the first attempt).

alter table mail_sends
  add column claimed_until timestamptz,
  add column attempts integer not null default 0,
  add column abandoned_at timestamptz,
  add column correlation text check (correlation ~ '^[0-9a-f]{64}$');

-- The migrating role is bound by forced RLS without a tenant context and would update nothing
-- (0005); unforced for the backfill, forced again after it.
alter table mail_sends no force row level security;
update mail_sends set attempts = 1 where attempted_at is not null;
alter table mail_sends force row level security;

-- Siblings by correlation and attempt time; the open intents #17 lists.
create index mail_sends_correlation on mail_sends (tenant_id, correlation, attempted_at)
  where correlation is not null;
create index mail_sends_unresolved on mail_sends (tenant_id, attempted_at)
  where attempted_at is not null and sent_at is null;
