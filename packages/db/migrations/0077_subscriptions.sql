-- Recurring giving (ADR 005 rules 1, 2, 5 and 7, brief MY-254 PR 1). `mandates` holds a donor's
-- authorisation at the provider by reference; `subscriptions` the promise to charge an amount every
-- month or year, with until when it is paid; `charge_attempts` the intent row written before each
-- charge, whose key is also the provider's idempotency key (ADR 019 rule 6). The payments a
-- subscription makes are ordinary `payments` with `subscription_id` and a `sequence`, and every
-- step of a subscription is a row of the same append-only `ledger_entries` (one ledger, choice 2),
-- which names exactly one of a payment or a subscription.
--
-- The status sets and the steps between them live in core (`money/subscription-model.ts`); the
-- checks here only keep out a value the state machine does not know.
--
-- A subscription and a mandate name their supporter by id and hold no address. An erasure first
-- ends a live subscription (`ended`, reason `erasure`, one ledger entry, no next charge), so an
-- erased donor is never charged again, invalidates the mandate, and then clears both ids; the
-- amounts and their history stay for the organisation's books (ADR 019 rule 8). The erasure role
-- gets exactly the columns that needs, and may append that one ledger entry.
--
-- Rejected: a separate history table for subscriptions (the ledger is one, choice 2), a nullable
-- `payment_id` without the check (an entry that names neither would be history of nothing), the
-- attempt's state on the subscription row (an attempt outlives the step that wrote it and is
-- looked up by key), and an `offer_id` beside `tier_id` (for a membership the offer is the paid
-- tier, choice 9; a foreign key keeps it inside the tenant).
create table mandates (
  id            uuid primary key,
  tenant_id     uuid not null references tenants(id),
  provider      text not null,
  customer_ref  text not null,
  mandate_ref   text not null,
  status        text not null check (status in ('valid', 'invalid')),
  method        text not null,
  supporter_id  uuid,
  created_at    timestamptz not null,
  updated_at    timestamptz not null,
  unique (tenant_id, id),
  foreign key (tenant_id, supporter_id) references supporters (tenant_id, id)
);
create index mandates_supporter on mandates (tenant_id, supporter_id)
  where supporter_id is not null;
alter table mandates enable row level security;
alter table mandates force row level security;
create policy tenant_isolation on mandates to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on mandates to mycel_app;

grant select (id, tenant_id, supporter_id), update (supporter_id, status, updated_at)
  on mandates to mycel_erasure;
create policy erasure_apply on mandates to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create table subscriptions (
  id                   uuid primary key,
  tenant_id            uuid not null references tenants(id),
  kind                 text not null check (kind in ('donation', 'membership')),
  status               text not null check (status in
                         ('pending', 'active', 'paused', 'cancelled', 'ended')),
  amount               integer not null check (amount > 0),
  currency             text not null check (currency ~ '^[A-Z]{3}$'),
  interval             text not null check (interval in ('month', 'year')),
  description          text not null check (length(description) between 1 and 140),
  locale               text not null,
  provider             text not null,
  supporter_id         uuid,
  mandate_id           uuid,
  started_at           timestamptz,
  periods_paid         integer not null default 0 check (periods_paid >= 0),
  paid_through         timestamptz,
  next_charge_at       timestamptz,
  cancel_at_period_end boolean not null default false,
  tier_id              uuid,
  price_version        integer check (price_version > 0),
  campaign_id          uuid,
  failed_attempts      integer not null default 0 check (failed_attempts >= 0),
  end_reason           text check (end_reason in
                         ('first-payment', 'dunning', 'erasure', 'period-end')),
  created_at           timestamptz not null,
  updated_at           timestamptz not null,
  unique (tenant_id, id),
  foreign key (tenant_id, supporter_id) references supporters (tenant_id, id),
  foreign key (tenant_id, mandate_id) references mandates (tenant_id, id),
  foreign key (tenant_id, tier_id) references access_tiers (tenant_id, id),
  foreign key (tenant_id, campaign_id) references campaigns (tenant_id, id),
  -- Only a live subscription has a next charge.
  check (next_charge_at is null or status = 'active'),
  check ((tier_id is null) = (price_version is null))
);
-- The list in the admin (newest first), a supporter's subscriptions, and what the run charges.
create index subscriptions_created on subscriptions (tenant_id, created_at desc, id desc);
create index subscriptions_supporter on subscriptions (tenant_id, supporter_id)
  where supporter_id is not null;
create index subscriptions_due on subscriptions (tenant_id, next_charge_at)
  where status = 'active';
alter table subscriptions enable row level security;
alter table subscriptions force row level security;
create policy tenant_isolation on subscriptions to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on subscriptions to mycel_app;

grant select (id, tenant_id, supporter_id, mandate_id, status, paid_through, failed_attempts,
              amount, currency),
  update (supporter_id, status, next_charge_at, end_reason, updated_at)
  on subscriptions to mycel_erasure;
create policy erasure_apply on subscriptions to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create table charge_attempts (
  tenant_id        uuid not null references tenants(id),
  key              text not null check (length(key) between 1 and 200),
  subscription_id  uuid not null,
  payment_id       uuid not null,
  status           text not null check (status in ('pending', 'sent', 'unknown', 'done')),
  created_at       timestamptz not null,
  updated_at       timestamptz not null,
  primary key (tenant_id, key),
  unique (tenant_id, payment_id),
  foreign key (tenant_id, subscription_id) references subscriptions (tenant_id, id)
);
create index charge_attempts_subscription on charge_attempts (tenant_id, subscription_id);
-- What the reconciliation asks after.
create index charge_attempts_open on charge_attempts (tenant_id, updated_at)
  where status in ('pending', 'unknown');
alter table charge_attempts enable row level security;
alter table charge_attempts force row level security;
create policy tenant_isolation on charge_attempts to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on charge_attempts to mycel_app;

alter table payments drop constraint payments_kind_check;
alter table payments add constraint payments_kind_check
  check (kind in ('donation', 'membership'));
alter table payments add column subscription_id uuid;
alter table payments add column sequence text not null default 'oneoff'
  check (sequence in ('oneoff', 'first', 'recurring'));
alter table payments add constraint payments_subscription
  foreign key (tenant_id, subscription_id) references subscriptions (tenant_id, id);
alter table payments add constraint payments_sequence_subscription
  check ((sequence = 'oneoff') = (subscription_id is null));
create index payments_subscription on payments (tenant_id, subscription_id, created_at desc)
  where subscription_id is not null;

-- An entry is a step of a payment or of a subscription, never both. A subscription entry says
-- what the step did (`step`) and where the subscription stands after it.
alter table ledger_entries alter column payment_id drop not null;
alter table ledger_entries add column subscription_id uuid;
alter table ledger_entries add column step text check (step in
  ('started', 'activated', 'renewed', 'charge-failed', 'paused', 'resumed',
   'cancel-at-period-end', 'cancelled', 'ended'));
alter table ledger_entries add column paid_through timestamptz;
alter table ledger_entries add column failed_attempts integer check (failed_attempts >= 0);
alter table ledger_entries add constraint ledger_entries_subscription
  foreign key (tenant_id, subscription_id) references subscriptions (tenant_id, id);
alter table ledger_entries add constraint ledger_entries_one_owner
  check (num_nonnulls(payment_id, subscription_id) = 1
         and (subscription_id is null) = (step is null)
         and (subscription_id is null) = (failed_attempts is null));
alter table ledger_entries add constraint ledger_entries_subscription_seq
  unique (tenant_id, subscription_id, seq);
alter table ledger_entries drop constraint ledger_entries_cause_check;
alter table ledger_entries add constraint ledger_entries_cause_check check (cause in
  ('checkout', 'return', 'webhook', 'reconcile', 'operator', 'charge', 'donor', 'erasure'));

-- The erasure's one ledger entry per subscription it ends; nothing else of the ledger.
grant select (tenant_id, subscription_id, seq), insert on ledger_entries to mycel_erasure;
create policy erasure_apply on ledger_entries to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
