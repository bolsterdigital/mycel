-- The giver changes the amount of a monthly or yearly gift through the self-service link (ADR 005
-- rule 6, brief MY-254 PR 3). Like every other step of a subscription it is one entry in the
-- ledger, with the new amount (`ledger_entries.amount`) and the cause `donor`; this only lets the
-- step's name through the check of 0077.
--
-- Rejected: recording the change as a `resumed` or another existing step (the ledger would say
-- something that did not happen), and a column for the old amount (the entry before it says it).
alter table ledger_entries drop constraint ledger_entries_step_check;
alter table ledger_entries add constraint ledger_entries_step_check check (step in
  ('started', 'activated', 'renewed', 'charge-failed', 'paused', 'resumed',
   'cancel-at-period-end', 'cancelled', 'ended', 'amount-changed'));
