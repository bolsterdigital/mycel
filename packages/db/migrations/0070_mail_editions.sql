-- Newsletter editions (ADR 018 rule 4, ADR 010 rules 6 to 9): what `mailing.edition.send` sent,
-- kept as it was sent. An edition is one send of one item to one list; it has one row per locale
-- it went out in, each with the revision that was published in that locale at that moment and
-- the mail rendered from it (subject, HTML, text part). Every recipient of a locale gets that
-- row's mail, and a later correction of the article changes no row here: `mycel_app` may insert
-- a row and move the two delivery columns, nothing else, and there is no delete.
--
-- `recipients` is the number of confirmed members of the list when the edition was sent, the
-- same on every locale row; who actually got a message is the intent row per recipient in
-- `mail_sends` (key `mailing.edition:<supporter>:<edition>`, ADR 019 rule 6). `delivered_through`
-- is the delivery job's place in the list (the last supporter id it handled) and `completed_at`
-- the moment it reached the end; both are the same on every row of an edition.
--
-- The rows hold no address and no supporter id. Who sent the edition is the audit row of the
-- command and the actor of its outbox event (ADR 035 rule 4: no further copy of an actor).
-- No role besides `mycel_app` gets a grant: delivery runs as a tenant job under RLS like any use
-- case (ADR 011 rule 3), so the background roles are unchanged.
--
-- Rejected: one row per edition with the locales in a JSON column (the archive copy of a locale
-- would be a key in a document instead of a row with a constraint), a table of recipients beside
-- `mail_sends` (a second record of who was sent what for an erasure to find), and an update grant
-- on the whole row (rule 4 would then rest on the code alone).
create table mail_editions (
  tenant_id          uuid not null references tenants(id),
  id                 uuid not null,
  locale             text not null check (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  item_id            uuid not null,
  revision_id        uuid not null,
  list               text not null check (list ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  subject            text not null check (subject <> '' and char_length(subject) <= 200),
  html               text not null check (html <> ''),
  text               text not null check (text <> ''),
  recipients         integer not null check (recipients >= 0),
  sent_at            timestamptz not null,
  delivered_through  uuid,
  completed_at       timestamptz,
  primary key (tenant_id, id, locale),
  foreign key (tenant_id, item_id, revision_id)
    references content_revisions (tenant_id, item_id, id)
);
create index mail_editions_item on mail_editions (tenant_id, item_id, sent_at desc);
alter table mail_editions enable row level security;
alter table mail_editions force row level security;
create policy tenant_isolation on mail_editions to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update (delivered_through, completed_at) on mail_editions to mycel_app;

-- The bulk stream's throughput is counted per tenant over the last minute of attempts.
create index mail_sends_subscriber_attempted on mail_sends (tenant_id, subscriber, attempted_at)
  where attempted_at is not null;
