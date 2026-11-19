# Transactional mail delivery

How Mycel sends one transactional message per intent (the double opt-in confirmation today, every transactional mail later), what it does when the provider's answer is lost, and what it promises. Decisions: ADR 019 rule 6, ADR 011, brief #22C. Code: `packages/core/src/mailing/send-attempts.ts` (`sendOnce`, `settleIntent`, `reconcileMail`), `packages/db/src/mailing.ts` (`mailSendsRepository`), `packages/mail-tem/src/tem.ts`.

**What it promises:** a message is never resent blind, and an intent is never closed on the strength of someone else's message. **What it does not promise:** exactly-once delivery. See [Residual risk](#residual-risk).

## The provider contract (Scaleway TEM, v1alpha1)

Verified on 2026-10-22 against the OpenAPI schema (`https://www.scaleway.com/en/developers/api/transactional-email/v1alpha1/schema.yml`).

1. **No idempotency key.** `POST /emails` takes `from`, `to`, `cc`, `bcc`, `subject`, `text`, `html`, `project_id`, `attachments`, `send_before` and `additional_headers`; no request id, no dedupe. The response holds one `Email` object per message with `id` (a UUID) and `message_id`, both assigned by TEM. Mycel sends its intent key as the header `X-Mycel-Send-Key` for investigation, but the `Email` object has no headers field and `GET /emails` cannot filter on one.
2. **Listing.** `GET /emails` filters on `project_id`, `domain_id`, `message_id`, `since`/`until` (on `created_at`, RFC 3339), `mail_from`, `mail_rcpt` (`mail_to` is deprecated), `statuses`, `subject`, `search` and `flags`. `GET /emails/{id}` gives `status` (`unknown | new | sending | sent | failed | canceled`), `try_count`, `last_tries[]` and `flags[]`.
3. **Consequence.** The only identity of a message at the provider is the `id` from the create response. When that response is lost (a timeout after acceptance, a dropped connection, a process that dies between call and commit), nothing at TEM ties that one message to this intent. Recipient, subject and a time window find a _set_ of messages, not an identity. An empty listing proves "not created" only when the call can no longer be running and the listing already shows what was created; Scaleway documents no indexing delay, so the second half is an assumption with a budget.

`TemMailer.lookup` therefore asks for `project_id`, `mail_rcpt`, `subject`, `since`, `until` and `page_size=100`, never `statuses` (the Dreamkit notifier saw internal errors on `statuses=new`), and returns every listed id whatever its status: `failed` or `canceled` still means TEM accepted the message, so the attempt ran. It returns `null` when it cannot answer completely: an HTTP error, no answer, a missing `total_count`, or more matches than one page holds. The adapter lists; the core judges.

## The intent row and its states

Every message has a row in `mail_sends` (migrations 0006, 0013) keyed by `<subscriber>:<event id>` (a newsletter: `mailing.edition:<supporter id>:<edition id>`, [below](#newsletter-editions)), holding timestamps, the provider id and a `correlation`, never an address. A row goes with its outbox event, 30 days after the event was processed and never while its `mail.reconcile` job is open ([jobs.md](jobs.md) § Retention); a form mail whose row and event are both gone reads as `expired` in `form.delivery.get`, not as pending. The state is derived; there is no status column:

| State     | Condition                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| new       | `attempted_at is null` (or no row)                                                                                            |
| in flight | `sent_at is null and abandoned_at is null and claimed_until > now()`                                                          |
| unknown   | `attempted_at is not null and sent_at is null and abandoned_at is null and (claimed_until is null or claimed_until <= now())` |
| sent      | `sent_at is not null`                                                                                                         |
| abandoned | `sent_at is null and abandoned_at is not null`                                                                                |

`correlation` is `sha256(tenant_id || '\n' || lower(recipient) || '\n' || subject)` in hex (a check constraint allows nothing else). Intents that a provider listing cannot tell apart share it; reconciliation counts them. `MailSendsRepository.unresolved(now)` returns the unknown and abandoned rows of a tenant, which is what the site status page shows (`ops.status.get`). The platform-wide view runs as its own role, `mycel_ops`, under ADR 011 rule 2 ([platform-api.md](platform-api.md)).

## Sending: one claim, three transactions

`sendOnce(deps, event, subscriber, message)`:

1. **Claim** in one statement (`claim`): an upsert that inserts the intent, or takes it over only when it is not sent, not abandoned, its lease has expired and `attempted_at` is still what the caller read. Postgres serialises the conflict update on the primary key, so of two simultaneous callers exactly one gets a row; the other returns `deferred`. The same transaction plans the job `mail.reconcile:<intent key>` at `attempted_at + RECONCILE_LAG_MS`, so the job exists if and only if the claim committed.
2. **Call** the provider outside any transaction, aborted after `SEND_TIMEOUT_MS`.
3. **Record** `sent_at` and the provider id, or `failed` (`last_error`, and the lease ends now: any failure, a 4xx included, is an unknown outcome, because a 5xx or a dropped connection can come after acceptance and an adapter cannot tell).

The result is `sent | reconciled | skipped | deferred | unknown | abandoned`. `sendOnce` does not throw for the provider: the outbox marks the subscriber delivered once the claim stands, and recovery is the job's.

## Reconciliation: a count, and unknown when in doubt

`settleIntent` decides what an attempt without an outcome became, in this order:

1. `sent_at` set: sent. `abandoned_at` set: abandoned. Lease running: in flight (never reconcile while someone talks to the provider).
2. Less than `RECONCILE_LAG_MS` since the attempt: unknown (the listing gets its budget).
3. `lookup` over the attempt's window `[attempted_at - CLOCK_SKEW_MS, attempted_at + SEND_TIMEOUT_MS + CLOCK_SKEW_MS]` returns null: unknown.
4. Siblings: this tenant's intents with the same `correlation` whose window overlaps this one, this intent included. _Known_ ids are the provider ids of siblings that are sent; _unaccounted_ ids are the listed ids minus the known ones; _unresolved_ siblings are not sent. An abandoned sibling stays unresolved: it was given up because nobody could place its message, and that message may be the unaccounted one.
5. No unaccounted id: **not sent**. The provider holds nothing in the window that is not someone else's, and the window is closed. The intent is claimed again (with the `attempted_at` it read as expectation) and sent; after `MAX_SEND_ATTEMPTS` it is abandoned instead.
6. Exactly one unaccounted id and exactly one unresolved sibling (this one): that message is ours, recorded as **reconciled** with its id. No resend.
7. Anything else (two unaccounted ids, two unresolved intents for one message, a message from outside `mail_sends` with the same address and subject): **unknown**.

So intent B never closes on message A: A's id is known once A is sent, and while A is unresolved itself the count is ambiguous and B stays unknown.

## The `mail.reconcile` job

A tenant job on the jobs table (ADR 011 consequences), payload `{ key, subscriber, eventId }`: ids only. The handler (`packages/api/src/jobs.ts`) reads the event from the outbox as `mycel_worker` (`readOutboxEvent`, the outbox's second reader under ADR 011 rule 1), refuses an event whose tenant is not the job's, plans itself a day later for a suspended tenant (ADR 015 rule 7), rebuilds the message through the subscriber's `MailSource` and runs `reconcileMail`. A terminal outcome finishes the job; `unknown`, `in flight` and `deferred` plan the next look at `RECONCILE_INTERVAL_MS`, until `RECONCILE_GIVE_UP_MS` after the attempt, when the intent is abandoned and stays visible. A missing event or an unknown subscriber is a programming error: the job fails, retries, and once exhausted is findable with its error (`done_at is null and attempts >= max_attempts`). One uncertain message holds up neither the outbox nor any other job: it has its own row and its own `next`.

Archiving processed outbox rows (ADR 011 rule 5) must keep events younger than `RECONCILE_GIVE_UP_MS` plus the job's retries, or their open reconcile jobs fail.

## Constants

| Constant                | Value   | Where                                        | Why                                                                                     |
| ----------------------- | ------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `SEND_TIMEOUT_MS`       | 30 s    | `packages/core/src/mailing/send-attempts.ts` | the provider call is aborted after this                                                 |
| `CLAIM_SLACK_MS`        | 30 s    | `packages/core/src/mailing/send-attempts.ts` | time past the call's timeout to commit the outcome                                      |
| `CLAIM_LEASE_MS`        | 60 s    | `packages/core/src/mailing/send-attempts.ts` | timeout plus slack; a lease that expires without `sent_at` means the outcome is unknown |
| `CLOCK_SKEW_MS`         | 60 s    | `packages/core/src/mailing/send-attempts.ts` | tolerance between our clock and the provider's `created_at`                             |
| `RECONCILE_LAG_MS`      | 15 min  | `packages/core/src/mailing/send-attempts.ts` | how long the listing gets to show an attempt; env `MAIL_RECONCILE_LAG_MINUTES`          |
| `RECONCILE_INTERVAL_MS` | 10 min  | `packages/core/src/mailing/send-attempts.ts` | the job's next look while the outcome is unknown                                        |
| `RECONCILE_GIVE_UP_MS`  | 24 h    | `packages/core/src/mailing/send-attempts.ts` | after this, an unknown attempt is abandoned and stays visible                           |
| `MAX_SEND_ATTEMPTS`     | 3       | `packages/core/src/mailing/send-attempts.ts` | attempts proven not to have arrived before the intent is abandoned                      |
| `LOOKUP_PAGE_SIZE`      | 100     | `packages/mail-tem/src/tem.ts`               | one page of the listing; more matches than this is an answer the core cannot count      |
| `CONFIRM_TTL_MS`        | 14 days | `packages/core/src/mailing/confirmation.ts`  | how long a confirmation link stays valid                                                |

## Residual risk

- **A late listing.** A message that TEM lists only after `RECONCILE_LAG_MS`, after an empty listing let a resend go out, is a duplicate that nobody sees. The budget is the knob: raise `MAIL_RECONCILE_LAG_MINUTES` if the real indexing delay turns out longer. Nobody has measured it yet; that needs production credentials.
- **A lost id.** A message accepted without an id in the response is recorded as sent with no provider id. Its siblings then see an unaccounted id they cannot place and stay unknown until they are given up: safe, not silent.
- **Ambiguity ends in abandonment.** Two intents in one window with one listed message stay unknown, also after one of them is given up, so both end abandoned and visible, even though one of them did arrive. The alternative, letting the survivor adopt the message, could close an intent on someone else's message.

## Configured form mail

Form notifications and designated transactional receipts use the same `sendOnce` and `mail.reconcile` protocol under subscriber `forms.mail`. Each accepted submission pins one event id per action-version/recipient; the source reads immutable resolved copy from that event and rechecks current activation, recipient approval, tenant access and the saved submission binding. Opt-in confirmation can use pinned form-specific copy, with the mandatory platform confirmation link retained. Template changes never resend old submissions. Configuration, quotas, capability boundaries and status/replay operations are documented in [forms](forms.md#private-mail-templates-and-actions).

## Newsletter editions

An article with `delivery.email` goes out as a newsletter through these use cases (`packages/core/src/mailing/edition.ts`; ADR 010 rules 6 to 9, ADR 018 rule 4):

| Use case               | Needs          | Does                                                                                                                                                               |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mailing.edition.get`  | `content:read` | the mail a send would make of one published locale, with the list and its confirmed subscribers; sends nothing. With `editionId`: that sent edition as it went out |
| `mailing.edition.list` | `content:read` | the editions of one article, newest first: when, list, count, locales and subjects, delivered or not; no mail                                                      |
| `mailing.edition.test` | `mailing:send` | that mail to the operator's own address, marked `[Test]`; no edition, no list                                                                                      |
| `mailing.edition.send` | `mailing:send` | stores the edition and plans its delivery                                                                                                                          |

`site` (name, root URL, default locale) is input, as for `mailing.email.get`; the admin derives it on the server from the tenant and its primary hostname (`apps/web/src/lib/server/mail/newsletter.ts`), never from a form.

**In the admin** (#250 PR 4): an article's edit screen has a Newsletter panel whose list and subject are fields of the document (`delivery.email`), saved and published with it. Test is one button there; sending goes through a confirmation page (`content/<id>/email/send`) that names list, count and languages, then shows "sent on ... to N" with a link to the edition as sent.

The three refuse (`conflict`) a locale that is not published, an article whose published revision names no list, and restricted content (ADR 016). `send` also refuses past `mail.monthly_max`. Writing or publishing content never sends: the registry conformance holds `mailing:send` to these two commands.

**The edition.** `mail_editions` (migration 0070) holds one row per locale of a send: the revision published in that locale at that moment and the subject, HTML and text rendered from it, once, through the `EmailRenderer`. The application role may insert a row and move `delivered_through` and `completed_at`; it cannot update or delete anything else, so a correction of the article never changes what was sent, and sending again is a new edition. The rows hold no address and no supporter id; the audit row of the command and the actor of the outbox event `mailing.edition.sent` say who sent it. The edition travels in a tenant export.

**One mail, each recipient's own link.** The stored mail carries `UNSUBSCRIBE_PLACEHOLDER` where the unsubscribe link goes. At delivery each recipient gets their signed link there, in the HTML and the text part, and `List-Unsubscribe` with `List-Unsubscribe-Post` in the headers (`unsubscribeLink`, RFC 8058). A recipient gets the locale they signed up in when the edition has it, else the site's default locale, else the edition's first; the signup locale is read from the supporter's own log.

**Delivery.** `send` publishes one outbox event whose id is the edition's and plans the tenant job `mailing.edition.deliver` (`packages/core/src/mailing/edition-delivery.ts`). Each run reads the next confirmed members of the list in id order after `delivered_through`, hands each to `sendOnce` under the key `mailing.edition:<supporter id>:<edition id>` on the `bulk` stream, records its place and plans itself a minute later until the list is done. So:

- only confirmed members get a message, read when their turn comes (ADR 019 rule 5): someone who unsubscribed or was erased before that gets nothing, and the claim checks the erasure register once more;
- a job that runs twice, or two workers on one job, send nothing twice: the intent row decides, as for every mail above, and an attempt without an outcome is reconciled by `mail.reconcile`, which rebuilds the message from the edition and the supporter id in the key;
- a tenant starts at most `mail.bulk_per_minute` newsletter attempts per minute, counted over all its editions (`attemptedSince`);
- bulk never delays transactional mail (ADR 010 rule 9): the outbox carries one event per edition, not one per recipient, and the job runs in the `newsletter` pool ([jobs.md](jobs.md));
- a suspended tenant, or one without `mailing.enabled`, sends nothing and is looked at again in a day.

An erasure deletes the erased supporter's edition intents by the id in their key (`applyErasures`); the other intents go with the edition's outbox event under the retention above.

| Constant                | Value | Where                                           | Why                                                                 |
| ----------------------- | ----- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `mail.bulk_per_minute`  | 120   | `packages/core/src/entitlements/model.ts`       | default newsletter throughput per tenant; an entitlement per tenant |
| `EDITION_RUN_BUDGET_MS` | 3 min | `packages/core/src/mailing/edition-delivery.ts` | one run stops sending well inside the job's five-minute lease       |

Not built yet, and needed before a first send from a production site: bounce and complaint webhooks into suppression, and the sending-domain check with warm-up (ADR 010 rule 8).

## Welcome series

The first automation of ADR 010 rule 10 (MY-258, `packages/core/src/mailing/automation.ts`, migration 0082): per list one series of one to five steps, each a published public page or article sent so many days (0 to 60) after a person joined the list.

| Use case                    | Needs             | Does                                                                                                   |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `mailing.automation.list`   | `supporters:read` | every series: list, on or off, steps, how many people started it and reached each step; no addresses   |
| `mailing.automation.update` | `mailing:send`    | sets the steps and the switch of one list's series, creating it; refuses an item that cannot be mailed |

**Trigger.** The outbox subscriber `mailing.automation` reacts to a confirmed `newsletter.subscribed` or a `consent.given` for a list whose series is on: it starts a run (`mail_automation_runs`, one row per series and person) and plans the tenant job `mailing.automation.step` for step 0. A pending double opt-in starts nothing, and the run's primary key makes a series start once per person: leaving and joining again does not start it over. Who was a member before the series was switched on gets nothing.

**A step.** The job checks that the series is on, the step exists and the person is still a member, then in one transaction moves the run's `through` to the step and publishes `mailing.automation.due` (ids only), and plans the next step at the moment of joining plus its delay. A job that runs twice finds `through` moved and publishes nothing. The subscriber `mailing.automation.mail` renders the item's revision published at that moment in the locale the person joined in (else the site's default) and sends it with `sendOnce` on the `bulk` stream, with the recipient's unsubscribe link and RFC 8058 headers; `mail.reconcile` rebuilds it from the due event. An item that is gone, unpublished in both locales or restricted is skipped and the next step still comes; switching the series off ends every run.

An erasure deletes the erased supporter's runs and the intents of their due events (`applyErasures`). The series and its steps travel in a tenant export; runs do not.
