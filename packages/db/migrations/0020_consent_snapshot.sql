-- 0020: the consent snapshot on the submission (TODO #22B, brief consent-confirmation § 1;
-- ADR 003, ADR 010 rule 5).
--
-- `list` and `consent_text_version` are copied from the form when the visitor submits, and
-- `mailing.confirm` reads them from here, never from `forms.definition`: once forms can be edited
-- (#11) the definition moves, and a click must confirm exactly what the person saw. Neither column
-- is ever updated after the insert, so mycel_app keeps only `update (confirmed_at)` (0006).
-- Rejected: reading the form at confirmation time (the probe did; it confirms a text the person
-- may never have seen), a separate consent table (a second copy of what this row holds) and a
-- form revision id (forms have no revisions yet, and the two values are the evidence itself).
--
-- Backfill: until this migration forms had no update path (`FormRepository` knows insert and
-- findById only), so the current definition of each submission's form is the one the visitor
-- submitted against. That makes these the provably original values, not a guess.
--
-- The schema owner sees no tenant row since 0018 (forced RLS, policies bound to mycel_app). The
-- backfill lifts `force` on the two tables for the length of this transaction, which holds an
-- access exclusive lock on both until commit, so no other session ever sees them unforced.
-- Rejected: looping over tenants as mycel_app (it would need a temporary update grant on columns
-- that must stay immutable for it) and a policy for the owner (the gap 0018 closed).
-- packages/db/src/consent-snapshot-migration.conformance.test.ts runs the block between the markers.

alter table form_submissions add column list text, add column consent_text_version text;

-- backfill:begin
alter table forms no force row level security;
alter table form_submissions no force row level security;
update form_submissions s
   set list = f.definition->>'list',
       consent_text_version = f.definition->>'consentTextVersion'
  from forms f
 where f.id = s.form_id and f.tenant_id = s.tenant_id
   and (s.list is null or s.consent_text_version is null);
alter table form_submissions force row level security;
alter table forms force row level security;
alter table form_submissions alter column list set not null,
                             alter column consent_text_version set not null;
-- backfill:end
