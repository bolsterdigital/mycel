-- A payment names the form submission that started it (brief MY-252 PR 2): the public donation
-- form stores a submission with the donor's address and opens the payment in the same
-- transaction. The payment holds no address; when it settles, the submission's address (with its
-- lifecycle) becomes the supporter the payment then names, as a signature does.
--
-- The submission goes with an erasure or the retention of submissions, and the reference goes
-- with it (`on delete set null`, only this column): the payment stays for the books. The roles
-- that delete submissions need nothing on `payments` for that, since a referential action runs
-- as the table's owner.
--
-- `form_submissions` gets the key `(tenant_id, id)` so the reference stays inside one tenant, as
-- every other cross-table reference does (ADR 002).
--
-- Rejected: copying the address onto the payment (a second copy for every erasure to find), and
-- linking the supporter at submission time (the projection exists only after the outbox ingest,
-- and an address that never paid would become a supporter for a gift it did not give).
alter table form_submissions add constraint form_submissions_tenant_id_id unique (tenant_id, id);

alter table payments add column submission_id uuid;
alter table payments add constraint payments_submission
  foreign key (tenant_id, submission_id) references form_submissions (tenant_id, id)
  on delete set null (submission_id);
create index payments_submission on payments (tenant_id, submission_id)
  where submission_id is not null;
-- The payments the reconciliation asks after: not yet settled, oldest change first.
create index payments_due on payments (tenant_id, updated_at)
  where status in ('created', 'open');
