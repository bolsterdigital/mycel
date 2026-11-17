# Donations

How Mycel records money (ADR 005). This page describes what is built: one-off donations over an owned ledger, with the payment provider behind a port, a public donation form, a return page and **Donations** in the admin. Recurring giving, mandates, dunning, donor self-service, refunds and memberships are decided in the ADR and not built yet.

## What is stored

| Table            | Holds                                                                                                                                                                   | Changes                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments`       | One row per attempt: amount in minor units, ISO currency, our status, the provider's reference and its own status word, supporter, form submission, fundraiser campaign | The use cases move `status`, `provider_status`, `checkout_url`, `paid_at` and, when it settles, `supporter_id`; the rest is fixed at insert |
| `ledger_entries` | One row per change of status: its place in the payment's history (`seq`), from, to, cause, the provider's word, amount, moment and the stored actor                     | Append-only: the application role may insert and select, nothing else                                                                       |

Both sit behind forced row-level security on `tenant_id` (migration 0072). A ledger reads in `seq` order, the order of writing: one walk writes several entries with the same moment, so neither the moment nor the id orders them. A payment names its supporter by id and holds no address. Amounts are integers; one payment moves between 100 and 5 000 000 minor units. One currency is accepted (`EUR`) until a tenant chooses its own; the code travels with every row and event.

## The state machine

`packages/core/src/money/model.ts` holds the statuses and the steps between them, and nothing else may move a status:

```
created → open → paid → refunded
   │        │       └──→ charged_back
   └→ failed ←─┤
            └→ expired
```

A provider reports where a payment stands now, not how it got there. `pathTo` gives the steps in between, so a reconciliation that finds `refunded` on a payment held as `open` records `open → paid` and `paid → refunded` as two entries, and what hangs on `paid` happens once. A report the table cannot reach (a provider that says `open` about a payment held as `paid`) changes nothing and is logged as `donation.check.unreachable`. A donor who backs out at the provider is a `failed` attempt; the provider's own word (`canceled`) is kept in `provider_status`.

## Use cases

| Use case          | Requires          | Does                                                                                                                                |
| ----------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `donation.create` | `donations:write` | Opens a checkout at the provider and records the payment; returns `checkoutUrl` and the donor's return `token`                      |
| `donation.check`  | `donations:write` | Asks the provider where the payment stands and records each step; addressed by `paymentId` or by `token`; repeating changes nothing |
| `donation.get`    | `donations:read`  | One payment with its ledger, oldest entry first                                                                                     |
| `donation.list`   | `donations:read`  | Newest first, optionally one status or one supporter; with `supporters:read` also the addresses of the supporters on the page       |

`donation.create` also needs the entitlement `donations.enabled` (ADR 015) and a configured provider. `returnUrl` must contain `{token}`; the provider sends the donor there with the signed token in place, and the page behind it calls `donation.check` with that token. The answer is the status, the amount, the currency, `paidAt` and, while the payment is open, its `checkoutUrl`; never who gave.

A webhook, the donor's return and a scheduled reconciliation all end in the same check (ADR 005 rule 4; the reconciliation calls `checkPayment` without the registry, see below): what a provider sends is a reason to look, never the answer. The use case takes no status as input, so a caller with the capability cannot mark a payment paid.

## The donation form

A form of kind `donation` ([forms.md](forms.md)) has exactly one required, unconditional `amount` field: the gift, in euros with at most two decimals, usually with three to six `presets` and an amount of one's own (`custom`, posted as `<name>-other`, which wins when filled in). `form.create` makes one with presets 10, 25 and 50, an e-mail field and an optional consent. `form.submit` refuses a gift outside 1 to 50 000 euros as a field error, needs `donations.enabled` and a configured provider before it counts or stores anything, and needs `returnUrl`; an accepted submission stores the submission and starts the payment in the same transaction (`startDonation`), so a provider that does not answer rolls the submission back too. The answer carries `checkoutUrl` and the return `token`. A ticked consent subscribes as on a signup; without it nothing is mailed and the recipient cooldown does not apply, so someone may give twice in a day.

The public front (`[[locale]]/[...path]`) posts the form and redirects to the return page `[[locale]]/donation/<token>?pay=1&back=<page>`: CSP `form-action 'self'` refuses a form post that redirects to another origin, and a checkout is one. That page asks `donation.check` (cause `return`) and, while the payment is open, sends the visitor on with an immediate meta refresh and a link to the checkout the use case names. Coming back from the provider, the same page says thank you, that it failed (with a link back to the page) or that it is being processed (with a link to look again). It shows the amount and nothing about who gave; `no-store`, `noindex`.

A donation form bound to a fundraiser campaign ([content-model.md](content-model.md), ADR 033) takes part like any bound form: `form.submit` refuses with `campaign.closed` outside open participation, before any checkout opens, and otherwise gives the payment the campaign's id (`campaignId`, migration 0075). The fundraiser's counter sums its paid payments.

## Supporters and erasure

A payment started by the form names its submission (`submission_id`, migration 0074) and no supporter: before it settles, the address gave nothing. When it settles, the event goes through the supporter ingest with the submission's address and lifecycle, as a signature does (`source_ref` `submission:<id>`), and the payment then names the supporter that ingest found or made. An erasure or the retention of submissions removes the submission and, by the foreign key, the reference.

With `supporterId`, a payment that settles is noted in that supporter's log as `donation.payment.succeeded` or `donation.payment.failed` with `payment_id`, `amount` and `currency`: a reference, the ledger stays the truth. Without it the gift is anonymous.

An erasure (ADR 019 rule 8) clears `supporter_id` and keeps the payment and its ledger: the organisation's record of what it received stays, with nobody attached. A payment of an erased supporter that settles later writes no event. The storage catalogue (`packages/db/src/portability/storage.ts`) lists both tables; an export carries them and an import brings them back as exported.

## The provider port

`PaymentProvider` (`money/ports.ts`) has two methods: `createCheckout` with our payment id as the idempotency key, and `fetchPayment` by reference. Both answer in the state machine's outcomes plus the provider's own word, so the core never reads a provider's vocabulary and compiles without any provider package. The port sits on the transaction context: opening a checkout moves no money and asking for a status is a read. Charging a mandate, when recurring giving is built, is an effect that cannot be taken back and gets an intent row and a key first (ADR 019 rule 6).

`FakePaymentProvider` in `@mycel/core/testing` is the provider for unit tests: `settle(ref, outcome)` plays the donor. The runtime takes `PAYMENT_PROVIDER`: `none` (the default; `donation.create` and a donation form answer `conflict`, "no payment provider is configured") or `fake`, refused in production: `DirectoryPaymentProvider` (`packages/api/src/runtime/fake-payments.ts`) keeps each payment as a JSON file in `PAYMENT_FAKE_DIR`, which web, API and worker share, and its checkout is a page of the site, `[[locale]]/_pay/<ref>`, with the buttons paid, failed and expired. The e2e runner and a trial installation use it. Mollie follows as a per-site connection (brief MY-252 PR 3).

## Reconciliation

`donations.reconcile` is an hourly platform job (`reconcileAllDonations` in `packages/api/src/jobs.ts`): per tenant it reads the payments still `created` or `open` and unchanged for a quarter of an hour (`dueDonations`, `RECONCILE_AFTER_MS`) and checks each in a transaction of its own with cause `reconcile`. It calls `checkPayment` directly, without the registry: the ledger entry is the record, not an audit row per payment per hour. A provider that does not answer about one payment leaves the others settled; that one is asked again the next hour.

## Admin

**Donations** under Manage (`/admin/<site>/donations`, `donations:read`) lists amount, status, date and who gave, newest first, filtered by status, fifty a page; who gave links to the supporter's page for a reader who may also read supporters. That page's history says "Gave €25" for `donation.payment.succeeded`.
