# ADR 005 - Donations and subscriptions are an owned ledger; the PSP is an adapter

- **Status**: accepted
- **Date**: 2026-10-21
- **Amended**: 2026-10-21, rule 7 added after the second-opinion review (subscription semantics for paid access)
- **Ownership scope**: 2026-10-24 [ADR 024](024-managed-integrations-and-external-ownership.md) permits an external subscription owner for a tenant; this ledger remains authoritative only where Mycel owns charging. No dual charging authority is permitted.

## Context

In Dreamkit, recurring donations live in Pronamic Pay's tables inside each WordPress install, with Mollie as the processor. The truth about a subscription is split between the plugin and the Mollie dashboard, a donor cannot see or change their own donation, and the whole thing is a paid add-on per site. Recurring giving is the single most valuable feature for the organisations we serve. Owning it is the moat; it is also where mistakes cost real money, so the scope is tight.

## Decision

1. **Mycel owns the ledger.** Tables: `mandates` (a donor's authorisation, with provider reference and status), `subscriptions` (amount, interval, next charge, status), `payments` (every attempt, with provider reference, outcome and raw provider status), and an append-only `ledger_entries` table that records every state change with cause. Amounts are integers in minor units with an ISO currency code; never floats.
2. **State machines are explicit and live in `packages/core`**: subscription `pending → active → paused → cancelled | ended`, payment `created → open → paid | failed | expired | refunded | charged_back`. Transitions are functions with tests; adapters may not mutate status directly.
3. **The payment provider is a port.** `PaymentProvider` exposes: create first payment (iDEAL, card, Bancontact, ...), create mandate from a successful first payment, charge a mandate, cancel, fetch status. The first adapter is **Mollie** (Dutch PSP, SEPA Direct Debit, Recurring API). A second adapter must be possible without touching the ledger; the test for this is that `core` compiles without the Mollie package.
4. **Provider webhooks are facts, not commands.** A webhook triggers a fetch of the provider's current state, which is reconciled into the ledger through the state machine. Webhooks are idempotent and signed; a missed webhook is recovered by a scheduled reconciliation.
5. **Dunning is in scope from the start**: a failed charge schedules a retry policy (configurable per tenant, sane default), notifies the donor through the mailing domain, and ends the subscription after the policy is exhausted. Each step is a ledger entry.
6. **Donor self-service is a core use case**: a donor can see, change amount, pause, resume and cancel their own subscription through a signed, expiring link sent to their e-mail address. No account required.
7. **A subscription records what was bought and until when it is paid.** `offer_id` and `price_version` (the offer catalogue is tenant data; prices stay out of this repository, ADR 015), `current_period_end` (`paidThrough`), `cancel_at_period_end`, and a tenant-configurable grace period after a failed charge. Paid access (ADR 016) derives from `paidThrough` plus grace, never from `status` alone: a yearly member who cancels today keeps access until the period ends. Newsletter consent (ADR 003), subscription status and content access are three separate facts and never imply one another.
8. **Out of scope, deliberately**: proration, multi-currency per tenant, invoicing and VAT (that is bookkeeping software's job; Mycel exports), split payments, marketplaces. Membership fees reuse the subscription model with a `kind` discriminator; they are not a separate ledger.

## Rejected alternatives

- **Let the PSP be the source of truth and only cache**: simplest, but reporting, dunning policy, donor self-service and provider portability all need our own record. Mollie's dashboard is not a product feature.
- **Stripe as first provider**: better API, but US-based, and SEPA Direct Debit for small Dutch and German non-profits is Mollie's home turf. Stripe is a plausible second adapter.
- **A generic double-entry accounting engine**: elegant and over-general. We need an auditable history of donations, not a general ledger; bookkeeping stays in Moneybird or its equivalent.

## Consequences

- The donation flow is the first thing with a real end-to-end test against Mollie's test mode in CI (secrets permitting), because this is where regressions hurt.
- Payment amounts, currencies and mandate references appear in supporter events (ADR 003) as references, never as the ledger's source of truth.
- Reporting (per campaign, per period, churn) is a read model over `ledger_entries`.
