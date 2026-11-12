-- A campaign signature has its own confirmation fact (ADR 033 rule 7). 0006
-- made `confirmed_at` the one double opt-in fact of a submission; on a campaign's form that same
-- column also counted the signature, so with an external consent owner whichever confirmation
-- came first turned the other into a no-op, and the participation time travelled to the provider
-- as consent time. `confirmed_at` keeps meaning confirmed consent and nothing else; this column
-- is the signature's, set once by the same kind of conditional update. Rejected: a field inside
-- `evaluation`, which is written once at insert and which mycel_app may not update.

alter table form_submissions add column participation_confirmed_at timestamptz;
grant update (participation_confirmed_at) on form_submissions to mycel_app;
