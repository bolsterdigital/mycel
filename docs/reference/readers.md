# Reader sign-in

A reader is a supporter who proved their e-mail address with a magic link and holds a session on one site ([ADR 016](../adr/016-readers-access-and-paywall.md) rule 1, [ADR 019](../adr/019-supporter-consistency-identity-and-retention.md) rules 1 and 5 to 8). There is no password and no second identity: the session names a supporter id. Code: `packages/core/src/readers/`, `packages/db/src/supporters/readers.ts` (migration 0069), the routes under `apps/web/src/routes/(public)/[tenant]/reader/`. What a signed-in reader may read is the access policy of [content-model.md](content-model.md#access-tiers-and-grants); signing in changes no page yet.

## The flow

1. **Ask.** The form on `/reader` posts `reader.signin.request` with an address. The answer is always `accepted` and the page is always "check your e-mail": a known address, an unknown one, a limited client, a bot and an erased address are told the same, so the route says nothing about who reads a site. When nothing refuses, the use case writes a link row and one outbox event, `reader.signin.requested`, whose id is the link's id and whose props hold that id and nothing else. It makes no supporter.
2. **Mail.** The subscriber `reader.signin.mail` builds the message from the link row after commit and sends it through `sendOnce` ([mail.md](mail.md)): transactional stream, in the locale of the page, to the site's primary hostname through `siteUrl` ([hostnames.md](hostnames.md)).
3. **Open.** The link opens `/reader/signin?token=...`, a page with one button. Opening it reads and writes nothing for the token, so a mail scanner signs nobody in and uses no link.
4. **Use.** The button posts `reader.signin.complete`. In one tenant transaction it uses the link, resolves the supporter of the address (a first sign-in makes one, and counts against `supporters.max`), appends the supporter event `reader.signed_in`, and writes a session row. Only then does the front set the cookie and redirect to the stored return path or `/reader`. Every failure is the one page `/reader/signin/invalid`.
5. **Read.** On each request the front asks `reader.session.get` whether the cookie names a standing session, and builds the reader principal from the answer.
6. **Leave.** `reader.signout`, run as the reader, ends the session row; the front deletes the cookie.

## The link

| Fact       | Value                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token      | The `Signer`'s signature over `{ typ: 'reader-signin', tid, lid, exp }`: tenant id, link id, expiry. No address.                                                                               |
| Stored     | `reader_signin_links`: the normalised address, a sha256 of the token, locale, return path, created, expires, consumed. Never the token.                                                        |
| Lifetime   | 15 minutes (`SIGNIN_LINK_TTL_MS`), one use.                                                                                                                                                    |
| Use        | One conditional update on id, token hash, `consumed_at is null` and `expires_at > now`: of two requests with one link, one gets the row.                                                       |
| Return     | A path on the same site, checked when stored and again when used (`safeReturnPath`): one leading slash, no second slash, backslash or control character. Anything else is dropped.             |
| Rebuilding | Signing is deterministic, so the mail source signs the row's token again and gets the same link. The outbox, the job payload, the intent row and the logs never hold the token or the address. |

A consumed or expired link, a row an erasure deleted and a suspended site give the mail source no message, so a retry after the link's time sends nothing.

## The session and the cookie

| Fact     | Value                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookie   | `mycel_reader`: host-only (no `Domain`), `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, `Path=/` on the site's hostname (the site's path prefix in the development path form). |
| Value    | The signature over `{ typ: 'reader-session', tid, sid, iat, exp }`: tenant id and session id. No address, supporter id or capability.                                            |
| Stored   | `reader_sessions`: session id, supporter id, created, expires, revoked.                                                                                                          |
| Lifetime | 12 hours after sign-in, absolute (`READER_SESSION_TTL_MS`); no renewal.                                                                                                          |

`reader.session.get` checks, on every request: the signature and `typ`, that the tenant in the value is the tenant of the hostname, the time, that the session row is neither revoked nor expired, that the supporter's projection is not a tombstone, and that no erasure is registered for the supporter. So sign-out, an erasure (from the moment it is registered) and a cookie carried to another site all end at once, and nothing about access is ever read from the cookie.

The reader principal is `{ kind: 'reader', sessionId }` with exactly `content:read` and `media:read` (`readerPrincipal`); the front cannot pass other capabilities. A reader reaches the use cases of an anonymous visitor plus `reader.signout` (`READER_USE_CASES`), whatever the principal carries. The three sign-in use cases admit only a visitor or a reader: an API key, an agent or an operator is refused before the input is read, over HTTP and MCP alike, so no key can sign a reader in or name a tenant or supporter in a body. The operator session is another cookie (`mycel_session`, `Path=/admin`, platform origin only) with another `typ`; neither value verifies as the other. In the audit log a reader is a visitor (`anonymous`, no id).

## Limits and spam defence

The request form follows the public form checklist ([forms.md](forms.md)): a honeypot field, a signed minimum fill time of two seconds, and ALTCHA proof of work scoped to `reader.signin`; a post without the honeypot field or the timing token is treated as a bot and gets the same answer. Limits are counters in `rate_limits`, shared between processes, keyed by digests:

| Limit                            | Value                    | Key                                       |
| -------------------------------- | ------------------------ | ----------------------------------------- |
| Mails per address per tenant     | 1 per 24 hours (sliding) | `emailKey(tenant, address, 'rate-limit')` |
| Requests per client address      | 10 per 10 minutes        | `Signer.hashIp` of the connection         |
| The same, without a solved proof | 3 per hour               | `Signer.hashIp` of the connection         |

A refused attempt never starts the address's 24 hours. Signing in needs no newsletter consent and writes none: `reader.signed_in` touches no list.

## The reader page

`/reader` on the site's own hostname is the sign-in form for a visitor and the account of a signed-in reader. `reader.account.get` (actor `reader` only) returns what the session's supporter holds on this site: the address, every grant with its tier name, kind, `until` and whether it stands now (an expired one stays listed as ended), the confirmed and pending newsletter lists, `lastSeenAt`, the session's end and the site's `readerActivityDays`. No grant reason, no supporter id. `reader.subscription.withdraw` (actor `reader` only) takes the reader off one list, confirmed or pending, with the same `newsletter.unsubscribed` event as the unsubscribe link (`via: reader`); a list they are not on answers `not_subscribed`. Neither takes a supporter or a tenant in its input, and both answer `not_found` once the session no longer stands, so a cookie can only ever reach its own supporter on its own site. Both sit in the registry's closed `READER_USE_CASES` list; an API key or an agent never becomes a reader.

The page sends `no-store` like the rest of the flow and works without JavaScript: one form per newsletter with one button, a sign-out button. Changing, pausing or cancelling a membership is not offered until the ledger offers it (ADR 005); the page states the access and says so. A reader without the tier an article asks for gets a link to this page in the article's prompt.

## Recovery, retention and erasure

- **Provider time-out.** The sign-in mail goes through the `mail_sends` intent and `mail.reconcile` like every transactional mail. An attempt without an outcome is `unknown` and is not resent. By the time the reconcile job looks, the link has usually expired, the source gives no message and the job ends; such an intent stays visible as unresolved. The person can ask again after the address's 24 hours.
- **Retention.** The hourly `rate_limits.sweep` deletes links and sessions that ended more than an hour ago, as `mycel_janitor`, whose policies reach no younger row. `reader.signed_in` events stay in the supporter log for the tenant's `readerActivityDays` (`site.retention.update`, default 90, 0 to 365); the daily `retention.apply` then deletes them once the projection's `lastSeenAt` holds them (ADR 019 rule 7, [jobs.md](jobs.md#retention)). Content views are never logged per reader.
- **Erasure.** `apply` deletes the pending links of an erased address with the mail intents and reconcile jobs of their events (found by the link id), and the sessions of an erased supporter. An erased address gets no new link: coming back after an erasure is an explicit signup through a form ([ADR 032](../adr/032-erasure-and-explicit-readmission.md)).
- **Export and import.** Neither table travels ([export.md](export.md#what-does-not-travel)): links and sessions belong to this installation's hostname and signing secret, so readers sign in again after a move. The supporters and their `reader.signed_in` events travel with the log.

## Tables

`reader_signin_links` and `reader_sessions` are tenant tables behind forced RLS. `mycel_app` may insert, read and set `consumed_at` or `revoked_at`; it can change no other column and delete nothing. `mycel_erasure` deletes on the current tenant; `mycel_janitor` deletes expired rows across tenants.
