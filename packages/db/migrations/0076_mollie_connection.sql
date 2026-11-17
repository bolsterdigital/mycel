-- MY-252 PR 3: a site's Mollie API key is a `mollie` connection, encrypted in
-- connection_credentials like every other credential (ADR 005 rule 3, ADR 024). It has no
-- destination, forms or scopes; the payment adapter reads the key of the site's active one.
-- Rejected: a key per installation in env (one site's gifts would land in another's account) and
-- a column on tenants (no encryption, and it would leave the connection inventory).
alter table connections drop constraint connections_provider_check;
alter table connections add constraint connections_provider_check
  check (provider in ('webhook', 'mailchimp', 'mollie'));
