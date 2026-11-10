-- The `erase` effect (ADR 018 rule 5 and ADR 015 rule 7 as amended 2026-11-10):
-- `supporter.erase` is a command whose effect cannot be undone, so it gets its own capability
-- `supporters:erase` and its audit row says `erase`. The check of 0015 lists the effects the
-- registry knows (registry.ts `UseCaseEffect`); without this the audit row of every erasure
-- request is refused and the request with it.
-- Rejected: recording the request without an effect (the audit log could no longer tell an
-- erasure from an ordinary write), and widening the check to any text (a typo in a new effect
-- would pass unseen).
alter table audit_log drop constraint audit_log_effect_check;
alter table audit_log add constraint audit_log_effect_check
  check (effect in ('publish', 'send', 'export', 'refund', 'erase'));
