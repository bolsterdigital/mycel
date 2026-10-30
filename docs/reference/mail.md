# Transactional mail delivery

How Mycel sends one transactional message per intent (the double opt-in confirmation today, every transactional mail later), what it does when the provider's answer is lost, and what it promises. Decisions: ADR 019 rule 6, ADR 011, brief #22C. Code: `packages/core/src/mailing/send-attempts.ts` (`sendOnce`, `settleIntent`, `reconcileMail`), `packages/db/src/repositories.ts` (`mailSendsRepository`), `packages/mail-tem/src/tem.ts`.

**What it promises:** a message is never resent blind, and an intent is never closed on the strength of someone else's message. **What it does not promise:** exactly-once delivery. See [Residual risk](#residual-risk).

## The provider contract (Scaleway TEM, v1alpha1)

Verified on 2026-10-22 against the OpenAPI schema (`https://www.scaleway.com/en/developers/api/transactional-email/v1alpha1/schema.yml`).

1. **No idempotency key.** `POST /emails` takes `from`, `to`, `cc`, `bcc`, `subject`, `text`, `html`, `project_id`, `attachments`, `send_before` and `additional_headers`; no request id, no dedupe. The response holds one `Email` object per message with `id` (a UUID) and `message_id`, both assigned by TEM. Mycel sends its intent key as the header `X-Mycel-Send-Key` for investigation, but the `Email` object has no headers field and `GET /emails` cannot filter on one.
2. **Listing.** `GET /emails` filters on `project_id`, `domain_id`, `message_id`, `since`/`until` (on `created_at`, RFC 3339), `mail_from`, `mail_rcpt` (`mail_to` is deprecated), `statuses`, `subject`, `search` and `flags`. `GET /emails/{id}` gives `status` (`unknown | new | sending | sent | failed | canceled`), `try_count`, `last_tries[]` and `flags[]`.
3. **Consequence.** The only identity of a message at the provider is the `id` from the create response. When that response is lost (a timeout after acceptance, a dropped connection, a process that dies between call and commit), nothing at TEM ties that one message to this intent. Recipient, subject and a time window find a _set_ of messages, not an identity. An empty listing proves "not created" only when the call can no longer be running and the listing already shows what was created; Scaleway documents no indexing delay, so the second half is an assumption with a budget.

`TemMailer.lookup` therefore asks for `project_id`, `mail_rcpt`, `subject`, `since`, `until` and `page_size=100`, never `statuses` (the Dreamkit notifier saw internal errors on `statuses=new`), and returns every listed id whatever its status: `failed` or `canceled` still means TEM accepted the message, so the attempt ran. It returns `null` when it cannot answer completely: an HTTP error, no answer, a missing `total_count`, or more matches than one page holds. The adapter lists; the core judges.

## The intent row and its states

Every message has a row in `mail_sends` (migrations 0006, 0013) keyed by `<subscriber>:<event id>`, holding timestamps, the provider id and a `correlation`, never an address. The state is derived; there is no status column:

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
