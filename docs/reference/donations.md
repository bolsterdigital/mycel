# Donations

How Mycel records money (ADR 005). This page describes what is built: one-off donations over an owned ledger, with the payment provider behind a port. Recurring giving, mandates, dunning, donor self-service, refunds and memberships are decided in the ADR and not built yet.

## What is stored

| Table            | Holds                                                                                                                             | Changes                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `payments`       | One row per attempt: amount in minor units, ISO currency, our status, the provider's reference and its own status word, supporter | The use cases move `status`, `provider_status`, `checkout_url`, `paid_at`; the rest is fixed at insert |
| `ledger_entries` | One row per change of status: from, to, cause, the provider's word, amount, moment and the stored actor                           | Append-only: the application role may insert and select, nothing else                                  |

Both sit behind forced row-level security on `tenant_id` (migration 0072). A payment names its supporter by id and holds no address. Amounts are integers; one payment moves between 100 and 5 000 000 minor units. One currency is accepted (`EUR`) until a tenant chooses its own; the code travels with every row and event.

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
| `donation.list`   | `donations:read`  | Newest first, optionally one status or one supporter                                                                                |

`donation.create` also needs the entitlement `donations.enabled` (ADR 015) and a configured provider. `returnUrl` must contain `{token}`; the provider sends the donor there with the signed token in place, and the page behind it calls `donation.check` with that token. The answer is the status, the amount, the currency and `paidAt`, never who gave.

A webhook, the donor's return and a scheduled reconciliation all end in `donation.check` (ADR 005 rule 4): what a provider sends is a reason to look, never the answer. The use case takes no status as input, so a caller with the capability cannot mark a payment paid.

## Supporters and erasure

With `supporterId`, a payment that settles is noted in that supporter's log as `donation.payment.succeeded` or `donation.payment.failed` with `payment_id`, `amount` and `currency`: a reference, the ledger stays the truth. Without it the gift is anonymous.

An erasure (ADR 019 rule 8) clears `supporter_id` and keeps the payment and its ledger: the organisation's record of what it received stays, with nobody attached. A payment of an erased supporter that settles later writes no event. The storage catalogue (`packages/db/src/portability/storage.ts`) lists both tables; an export carries them and an import brings them back as exported.

## The provider port

`PaymentProvider` (`money/ports.ts`) has two methods: `createCheckout` with our payment id as the idempotency key, and `fetchPayment` by reference. Both answer in the state machine's outcomes plus the provider's own word, so the core never reads a provider's vocabulary and compiles without any provider package. The port sits on the transaction context: opening a checkout moves no money and asking for a status is a read. Charging a mandate, when recurring giving is built, is an effect that cannot be taken back and gets an intent row and a key first (ADR 019 rule 6).

`FakePaymentProvider` in `@mycel/core/testing` is the provider for tests: `settle(ref, outcome)` plays the donor. No adapter is wired into the runtime yet, so on an installation `donation.create` answers `conflict` ("no payment provider is configured").
