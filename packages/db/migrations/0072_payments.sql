-- The money ledger for one-off payments (ADR 005 rules 1 and 2, brief MY-252 PR 1). `payments`
-- holds every attempt with the provider's reference and raw status beside our own status;
-- `ledger_entries` is the append-only history of every change of that status, with its cause.
-- Amounts are integers in minor units with an ISO currency code.
--
-- The status set and the steps between them live in core (`money/model.ts`); the check below
-- only keeps a value out that the state machine does not know. The application role may insert
-- and read ledger entries and nothing else: an entry is never changed or removed, so a reviewer
-- of the books reads what happened, not what someone later made of it.
--
-- A payment names its supporter by id and holds no address. An erasure clears that id and keeps
-- the row: the amount and its history stay for the organisation's books, with nobody attached
-- (ADR 019 rule 8). The erasure role gets exactly that column.
--
-- Rejected: one `status` enum type (a later status is then a type migration under load), the
-- ledger as jsonb on the payment (an update would rewrite history), and a foreign key from a
-- ledger entry's actor to operators (an actor is copied into history at rest, ADR 035 rule 4).
create table payments (
  id               uuid primary key,
  tenant_id        uuid not null references tenants(id),
  kind             text not null check (kind in ('donation')),
  status           text not null check (status in
                     ('created', 'open', 'paid', 'failed', 'expired', 'refunded', 'charged_back')),
  amount           integer not null check (amount > 0),
  currency         text not null check (currency ~ '^[A-Z]{3}$'),
  description      text not null check (length(description) between 1 and 140),
  locale           text not null,
  provider         text not null,
  provider_ref     text not null,
  provider_status  text not null,
  checkout_url     text,
  supporter_id     uuid,
  created_at       timestamptz not null,
  updated_at       timestamptz not null,
  paid_at          timestamptz,
  unique (tenant_id, id),
  -- One row per payment at a provider: a second insert for the same reference is a bug.
  unique (tenant_id, provider, provider_ref),
  foreign key (tenant_id, supporter_id) references supporters (tenant_id, id),
  check (paid_at is null or status in ('paid', 'refunded', 'charged_back'))
);
-- The list in the admin (newest first) and a supporter's payments, for the erasure route too.
create index payments_created on payments (tenant_id, created_at desc, id desc);
create index payments_supporter on payments (tenant_id, supporter_id) where supporter_id is not null;
alter table payments enable row level security;
alter table payments force row level security;
create policy tenant_isolation on payments to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update on payments to mycel_app;

grant select (id, tenant_id, supporter_id), update (supporter_id) on payments to mycel_erasure;
create policy erasure_apply on payments to mycel_erasure
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create table ledger_entries (
  id               uuid primary key,
  tenant_id        uuid not null references tenants(id),
  payment_id       uuid not null,
  from_status      text,
  to_status        text not null,
  cause            text not null check (cause in
                     ('checkout', 'return', 'webhook', 'reconcile', 'operator')),
  provider_status  text not null,
  amount           integer not null check (amount > 0),
  currency         text not null check (currency ~ '^[A-Z]{3}$'),
  at               timestamptz not null,
  actor            jsonb not null check (jsonb_typeof(actor) = 'object'),
  foreign key (tenant_id, payment_id) references payments (tenant_id, id)
);
create index ledger_entries_payment on ledger_entries (tenant_id, payment_id, at, id);
alter table ledger_entries enable row level security;
alter table ledger_entries force row level security;
create policy tenant_isolation on ledger_entries to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert on ledger_entries to mycel_app;
