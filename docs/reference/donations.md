# Donations

How Mycel records money (ADR 005). This page describes what is built: one-off donations over an owned ledger, with the payment provider behind a port (Mollie per site, or a fake one for trials), a public donation form, a return page, a webhook and **Donations** in the admin; and monthly and yearly giving with mandates, an hourly charge run and dunning, chosen on the donation form and listed under **Donations → Recurring** ([Subscriptions](#subscriptions), MY-254 PR 1-2). Donor self-service, the mails, memberships and Mollie's recurring API follow in MY-254 PR 3-5; refunds are decided in the ADR and not built yet.

## What is stored

| Table            | Holds                                                                                                                                                                                | Changes                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments`       | One row per attempt: amount in minor units, ISO currency, our status, the provider's reference and its own status word, supporter, form submission, fundraiser campaign              | The use cases move `status`, `provider_status`, `checkout_url`, `paid_at` and, when it settles, `supporter_id`; the rest is fixed at insert |
| `ledger_entries` | One row per change of a payment or a subscription (exactly one of the two ids): place in that history (`seq`), from, to, cause, the provider's word, amount, moment and stored actor | Append-only: the application role may insert and select, nothing else                                                                       |

Both sit behind forced row-level security on `tenant_id` (migration 0072). A subscription's entry also records its `step`, `paid_through` and `failed_attempts` (0077). A ledger reads in `seq` order, the order of writing: one walk writes several entries with the same moment, so neither the moment nor the id orders them. A payment names its supporter by id and holds no address. Amounts are integers; one payment moves between 100 and 5 000 000 minor units. One currency is accepted (`EUR`) until a tenant chooses its own; the code travels with every row and event.

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

`donation.create` also needs the entitlement `donations.enabled` (ADR 015) and a configured provider. `returnUrl` must contain `{token}` and lie on this site: a hostname of the site (its platform hostname, or a custom one once verified) with the platform's scheme and port, or the platform origin, where the path form of every site lives; anything else is refused with `donation.return-url.foreign`. The token is the donor's only key to their page, so it never goes to another host. the provider sends the donor there with the signed token in place, and the page behind it calls `donation.check` with that token. The answer is the status, the amount, the currency, `paidAt` and, while the payment is open, its `checkoutUrl`; never who gave.

A webhook, the donor's return and a scheduled reconciliation all end in the same check (ADR 005 rule 4; the webhook and the reconciliation call `checkPayment` without the registry, see below): what a provider sends is a reason to look, never the answer. The use case takes no status as input, so a caller with the capability cannot mark a payment paid.

## The donation form

A form of kind `donation` ([forms.md](forms.md)) has exactly one required, unconditional `amount` field: the gift, in euros with at most two decimals, usually with three to six `presets` and an amount of one's own (`custom`, posted as `<name>-other`, which wins when filled in). `form.create` makes one with presets 10, 25 and 50, an e-mail field and an optional consent. `form.submit` refuses a gift outside 1 to 50 000 euros as a field error, needs `donations.enabled` and a configured provider before it counts or stores anything, and needs `returnUrl`; an accepted submission stores the submission and starts the payment in the same transaction (`startDonation`), so a provider that does not answer rolls the submission back too. The answer carries `checkoutUrl` and the return `token`. A ticked consent subscribes as on a signup; without it nothing is mailed and the recipient cooldown does not apply, so someone may give twice in a day.

The `amount` field may offer `intervals` (`once`, `month`, `year`, in the order shown; absent means once only, and only a donation form may offer more). The page asks "How often?" as radio buttons above the amounts, posted as `<name>-interval`, the first offered checked; `form.submit` refuses an interval the field does not offer as a field error, and refuses monthly or yearly without an address. Monthly or yearly starts a subscription instead of a one-off payment (`startSubscription`, description "Monthly donation"), whose first payment asks for a mandate and passes the donor's address to the provider, which keeps its customer by it; a one-off gift sends none. The return page then says "From now on you give €10 a month" (`donation.return.check` returns the `interval`). Editors tick the intervals in the field editor of the form.

The public front (`[[locale]]/[...path]`) posts the form and redirects to the return page `[[locale]]/donation/<token>?pay=1&back=<page>`: CSP `form-action 'self'` refuses a form post that redirects to another origin, and a checkout is one. That page asks `donation.check` (cause `return`) and, while the payment is open, sends the visitor on with an immediate meta refresh and a link to the checkout the use case names. Coming back from the provider, the same page says thank you, that it failed (with a link back to the page) or that it is being processed (with a link to look again). It shows the amount and nothing about who gave; `no-store`, `noindex`.

A donation form bound to a fundraiser campaign ([content-model.md](content-model.md), ADR 033) takes part like any bound form: `form.submit` refuses with `campaign.closed` outside open participation, before any checkout opens, and otherwise gives the payment the campaign's id (`campaignId`, migration 0075). The fundraiser's counter sums its paid payments.

## Supporters and erasure

A payment started by the form names its submission (`submission_id`, migration 0074) and no supporter: before it settles, the address gave nothing. When it settles, the event goes through the supporter ingest with the submission's address and lifecycle, as a signature does (`source_ref` `submission:<id>`), and the payment then names the supporter that ingest found or made. An erasure or the retention of submissions removes the submission and, by the foreign key, the reference.

With `supporterId`, a payment that settles is noted in that supporter's log as `donation.payment.succeeded` or `donation.payment.failed` with `payment_id`, `amount` and `currency`: a reference, the ledger stays the truth. Without it the gift is anonymous.

An erasure (ADR 019 rule 8) clears `supporter_id` and keeps the payment and its ledger: the organisation's record of what it received stays, with nobody attached. A payment of an erased supporter that settles later writes no event. The storage catalogue (`packages/db/src/portability/storage.ts`) lists both tables; an export carries them and an import brings them back as exported.

## The provider port

`PaymentProvider` (`money/ports.ts`) has two methods every adapter implements: `createCheckout` with our payment id as the idempotency key (and `sequence` `oneoff` or `first`), and `fetchPayment` by reference. Two more are optional and make an adapter fit for recurring giving: `chargeMandate` and `findCharge` ([Subscriptions](#subscriptions)). All answer in the state machine's outcomes plus the provider's own word, so the core never reads a provider's vocabulary and compiles without any provider package. The port sits on the transaction context: opening a checkout moves no money and asking for a status is a read. Charging a mandate is an effect that cannot be taken back and gets an intent row and a key first (ADR 019 rule 6).

`FakePaymentProvider` in `@mycel/core/testing` is the provider for unit tests: `settle(ref, outcome)` plays the donor, a paid first payment leaves a mandate, and a charge settles as `chargesAs` says (`paid` by default); `failNext` plays an outage and `loseNext` a charge whose answer never arrives. The runtime takes `PAYMENT_PROVIDER`: `none` (the default; `donation.create` and a donation form answer `conflict`, "no payment provider is configured") or `fake`, refused in production: `DirectoryPaymentProvider` (`packages/api/src/runtime/fake-payments.ts`) keeps each payment as a JSON file in `PAYMENT_FAKE_DIR`, which web, API and worker share, and its checkout is a page of the site, `[[locale]]/_pay/<ref>`, with the buttons paid, failed and expired. The e2e runner and a trial installation use it.

### Mollie

`PAYMENT_PROVIDER=mollie` takes payments through Mollie with each site's own account. The site's API key (`test_…` or `live_…`) is a connection of provider `mollie` under **Connections** in the admin: stored encrypted in `connection_credentials` like every credential (needs `CONNECTION_CREDENTIAL_KEY`), with no destination, forms or scopes, and never readable through a use case. The composition root builds a `MolliePaymentProvider` (`packages/pay-mollie`) per transaction and hands it a function that reads the key of the site's active `mollie` connection only when a call needs it (`paymentCredential` in `packages/db/src/connections/connections.ts`). A site without an active one cannot start a payment: the provider refuses and the form answers `conflict`. Pausing or disconnecting the connection stops new payments; open ones then wait for the next check that finds a key.

The adapter sends our payment id as Mollie's `Idempotency-Key`, the amount as a decimal string, the locale where Mollie knows it, and gives up after five seconds, because a check holds locks while it waits. It reads Mollie's statuses into the state machine's: `open`, `pending` and `authorized` are `open`; `paid` is `paid`, or `charged_back` with any amount charged back, or `refunded` when the whole amount is refunded (a partial refund stays `paid`); `canceled` and `failed` are `failed`; `expired` is `expired`. A status it does not know throws, so nothing moves until it is mapped. Its tests run against recorded answers in `packages/pay-mollie/fixtures`.

### The webhook

With `PUBLIC_API_URL` on https, each Mollie payment gets a webhook URL `/hooks/payments/<capability>` on the API, where the capability is a signed token for exactly that tenant and payment (`paymentWebhookToken`). Mollie posts `id=tr_…`; `receivePaymentWebhook` (`money/webhook.ts`) verifies the capability, compares the posted reference with the payment's, limits a payment to thirty calls a minute and then runs the same `checkPayment` with cause `webhook`, without the registry, as the reconciliation does. A forged or unknown call gets the same 200 as a real one; a provider that does not answer gets a 503, so Mollie calls again. Without `PUBLIC_API_URL` (a local installation Mollie cannot reach) there is no webhook and the donor's return and the reconciliation settle the payment.

The checkout itself needs nothing from the site's Content-Security-Policy: the form posts to the site's own return page (`form-action 'self'`), which sends the visitor on to Mollie with a meta refresh and a link, both navigations that CSP does not restrict.

## Reconciliation

`donations.reconcile` is an hourly platform job (`reconcileAllDonations` in `packages/api/src/jobs.ts`): per tenant it reads the payments still `created` or `open` and unchanged for a quarter of an hour (`dueDonations`, `RECONCILE_AFTER_MS`) and checks each in a transaction of its own with cause `reconcile`. It calls `checkPayment` directly, without the registry: the ledger entry is the record, not an audit row per payment per hour. A provider that does not answer about one payment leaves the others settled; that one is asked again the next hour.

## Admin

**Donations** under Manage (`/admin/<site>/donations`, `donations:read`) lists amount, status, date and who gave, newest first, filtered by status, fifty a page; who gave links to the supporter's page for a reader who may also read supporters. That page's history says "Gave €25" for `donation.payment.succeeded`.

**Donations → Recurring** (`/admin/<site>/donations/recurring`, MY-254 PR 2), a second list behind a sub-navigation, shows each monthly or yearly gift as "€10 a month" with its status, next charge, failed charges and giver, filtered by status. A gift's own page has its facts, its payments (first payment and charges) and its ledger, newest first, and "Stop" (`donation.subscription.cancel`, `donations:write`) in a dialog. The supporter's page says "Gives €10 a month" with a link to the gift, and its history "Started giving €10 a month", "Gift of €10 a month stopped" or "... ended" for the subscription events.

## Subscriptions

Monthly and yearly giving (ADR 005 rules 1-7, brief MY-254 PR 1), in `packages/core/src/money/subscription-model.ts`, `subscription-steps.ts` and `subscriptions.ts`, migration 0077. Started from the donation form ([The donation form](#the-donation-form)) and charged by the worker (PR 2); the donor's own page and the mails follow in PR 3, memberships in PR 4, and Mollie's adapter refuses a subscription until PR 5. On a trial installation (`PAYMENT_PROVIDER=fake`) a first payment paid on the fake screen leaves a mandate, and a charge of it is settled at once: `paid`, or `failed` when the donor's address contains `+fail`, so the dunning can be shown without buttons. Only that verdict is kept, not the address.

`subscriptions` holds what was promised and where it stands: kind (`donation`, `membership`), amount, interval (`month`, `year`), status, supporter, mandate, `started_at`, `periods_paid`, `paid_through`, `next_charge_at`, `cancel_at_period_end`, tier and price version, fundraiser, `failed_attempts` and `end_reason`. `mandates` holds the donor's authorisation at the provider by reference (customer and mandate reference, method, `valid` or `invalid`, supporter). `charge_attempts` holds the intent row written before each charge: key, subscription, the payment id it gets, and `pending`, `sent`, `unknown` or `done`.

A subscription's payments are ordinary `payments` with `subscription_id` and `sequence` (`first` for the payment the donor makes, `recurring` for a charge); a one-off gift is `oneoff`. Everything that hangs on a payment (the fundraiser's counter, the supporter's events, the reconciliation, the webhook) works for them unchanged.

### The state machine

```
pending → active ⇄ paused
   │        │        │
   └────────┴────────┴──→ cancelled | ended
```

`cancelled` is a person's decision, `ended` everything else (`end_reason`: `first-payment`, `dunning`, `erasure`, `period-end`). Each step, and each step that keeps the status (`renewed`, `charge-failed`, `cancel-at-period-end`), is one ledger entry with its cause (`checkout`, `return`, `webhook`, `reconcile`, `operator`, `charge`, `donor`, `erasure`).

- **Start.** `startSubscription` opens a checkout with `sequence: 'first'` and records the subscription `pending` and its first payment, through the same path as a one-off gift (`startPayment`): same checks, same return page and token. A provider without `chargeMandate` refuses with `conflict`.
- **First payment.** When it is `paid`, `onPaymentSettled` records the mandate the provider reports, makes the subscription `active`, starts the first period at `paidAt` and sets `next_charge_at = paid_through`; `donation.subscription.started` goes into the giver's log. When it fails or expires, the subscription is `ended` (`first-payment`) without an event.
- **Charges.** A paid charge adds one period, counted from `started_at` so the day of the month stays (31 January, end of February, 31 March), and resets `failed_attempts`. A failed or expired charge, or a chargeback of any payment, counts one failed attempt; the dunning policy (`DEFAULT_DUNNING`: retries on day 3 and day 7 after the charge was due, grace 14 days) sets the next charge, and after the third failure the subscription `ended` (`dunning`) with `donation.subscription.ended`. A chargeback leaves `paid_through` and the next charge where they were.
- **Cancel.** `donation.subscription.cancel` stops a gift at once (`cancelled`, `donation.subscription.cancelled`). A membership instead gets `cancel_at_period_end` and becomes `cancelled` when the charge run reaches its `paid_through`.

### The charge run

`chargeSubscription(uow, principal, id)` charges one subscription in three transactions (ADR 019 rule 6). The first locks it, checks that it is `active` and due and has no attempt in flight, and writes the attempt `pending` with key `subscription:<id>:<paid_through>:<n>`, the n-th attempt for that period. The second only calls `chargeMandate` with that key as the provider's idempotency key and the attempt's payment id. The third records the payment the provider made (`sent`) and walks it like any other, which moves the subscription; when the call threw it marks the attempt `unknown` instead. A subscription with an attempt that is not `done` is not charged. `reconcileChargeAttempt` asks `findCharge` about an attempt, `unknown` or `pending`, once it is a quarter of an hour old (`staleChargeAttempts`, `ATTEMPT_RECONCILE_AFTER_MS`; a younger one is left `waiting`, whoever asks, because a request whose answer was lost may still reach the provider): it records the payment it finds, or closes the attempt when the provider made none, so the next run charges with a new key. Nothing charges twice and nothing retries without asking first. `dueSubscriptions` lists what is due. `subscriptions.charge` is an hourly platform job (`chargeAllSubscriptions` in `packages/api/src/jobs.ts`): per tenant it first asks after the stale attempts, then charges every due subscription, each in its own transactions and without the registry; a subscription that throws is tried the next hour.

### Use cases

| Use case                       | Requires          | Does                                                                                                     |
| ------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `donation.subscription.get`    | `donations:read`  | One subscription with its ledger (oldest first) and its payments (newest first)                          |
| `donation.subscription.list`   | `donations:read`  | Newest first, optionally one status, kind or supporter; with `supporters:read` also the addresses        |
| `donation.subscription.cancel` | `donations:write` | Stops a gift at once, a membership at the end of its period; cancelling what has stopped changes nothing |

### Erasure

An erasure ends a live subscription first (`ended`, reason `erasure`, one ledger entry with cause `erasure`, no next charge), so an erased donor is never charged again; it marks the mandate `invalid` and then clears `supporter_id` on both. The amounts, the payments and both ledgers stay for the books. A charge already in flight is still recorded when it settles, without a supporter.
