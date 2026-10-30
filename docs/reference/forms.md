# Forms

How a visitor's signup becomes a stored submission, a confirmation mail and a supporter event. A form definition is validated data referenced from a page's form block (ADR 010); the module validates the posted values on the server, runs the spam defence that ADR 010 rule 5 makes mandatory, reserves a supporter seat (ADR 015 rule 3) and publishes `newsletter.subscribed` through the outbox (ADR 011). Code: `packages/core/src/forms/`, the double opt-in in `packages/core/src/mailing/confirmation.ts` and `packages/core/src/mailing/service.ts`. The confirmation mail's delivery is in [mail.md](mail.md); what the supporter module does with the events is in [supporters.md](supporters.md). Decisions: [ADR 010](../adr/010-forms-and-mailing-built-in.md), [ADR 023](../adr/023-configurable-forms-and-actions.md).

## The definition

`FormDefinition` (`forms/model.ts`) has one kind, `signup`, and two field types, `email` and `consent`. A signup has exactly one e-mail field and at least one consent field; a consent field is always required. Labels, the submit label and the thank-you text are localised maps (`localized()`, see [i18n.md](i18n.md)).

| Field                | Content                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `id`                 | UUID                                                                               |
| `kind`               | `signup`                                                                           |
| `list`               | the consent scope a signup joins (ADR 010 rule 6), `^[a-z0-9][a-z0-9-]{0,62}$`     |
| `fields`             | `email` and `consent` fields, each with a `name` matching `^[a-z][a-z0-9_]{0,40}$` |
| `consentTextVersion` | which consent text the visitor saw; copied onto the submission and the events      |
| `minFillSeconds`     | minimum seconds between rendering and submitting, 0 to 60, default 3               |

Planned, ADR 023: a wider typed field vocabulary (text, phone, number, date, choices, amount, hidden), conditional visibility and requiredness, versioned definitions, multiple per-form notifications and connector actions. None of these exists in the code yet.

## Ports

`forms/ports.ts` adds three repositories to the transaction context:

| Port                   | Methods                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FormRepository`       | `findById`, `insert`                                                                                                                                                        |
| `SubmissionRepository` | `insert`, `findById`, `confirm(id, at)`: one conditional update, true only for the call that set `confirmedAt`                                                              |
| `RateLimiter`          | `hit(key, { max, windowSeconds })`: fixed-window counter; `cooldown(key, seconds)`: sliding window of one that records only a success, refused above `MAX_COOLDOWN_SECONDS` |

The rate limiter runs in the use case's transaction, so a refusal must commit: `form.submit` returns a `rejected` result instead of throwing.

## Use cases

- **`form.get`** (`forms:read`) returns the definition plus a fresh signed timing token (`startedToken`) and a proof-of-work challenge for rendering it publicly.
- **`form.submit`** (`forms:write`, `consumes: 'supporters.max'`) returns `accepted` with a submission id, `invalid` with field errors as i18n keys, or `rejected` with a reason.

## The order of checks in `form.submit`

For an anonymous principal (the public site) only, in this order: the honeypot must be present and empty (`honeypot`), the timing token must be valid and signed for this form (`token-invalid`) and old enough (`too-fast`), and a posted proof must verify (`proof-invalid`). A verified proof is used once: a `cooldown` on `forms.proof:<challenge>` for 24 hours refuses a second post of the same solution. An absent proof (no JavaScript) is not refused (ADR 009); the post is marked unproven.

Then, when the principal carries an IP hash (an anonymous visitor): the per-IP limit, and for an unproven post also the stricter per-IP unproven limit (`ip-limited`). Then field validation. Then, under the tenant's admission lock, the recipient cooldown on `forms.confirm:<form>:<sha256(tenant:email)>` (`recipient-limited`): at most one confirmation mail per address per form per day. A refusal at any step writes no submission, no event and no seat. Each refusal logs `form.submit.rejected` with a fixed reason, never the address.

The public `reason` is coarser than the log: honeypot, token and proof failures are all `spam`; `ip-limited` is `rate-limited`. The web front answers `spam` and `recipient-limited` with the same thank-you redirect as an accepted post, so neither a bot nor a third party learns anything; `rate-limited` is a visible 429.

## Proof of work

`forms/proof.ts` implements the ALTCHA v1 protocol with SHA-256. The server picks a salt and a secret number in `[0, maxNumber]`, sends `sha256hex(salt + number)` and signs form id, challenge and expiry with the `Signer`. `apps/web/static/_form/proof.js` searches for the number, writes the base64 solution into the hidden `_proof` field and waits at most two seconds before posting without one. `checkProof` answers `absent`, `invalid` (malformed, wrongly signed, expired, another form's, or not a solution) or `ok`.

## The public route

`apps/web/src/routes/(public)/[tenant]/[[locale=locale]]/[...path]/+page.server.ts` handles the native form post of a page (no JavaScript required). The tenant comes from the site being visited and the locale from the path; nothing in the body chooses either. The visitor is an anonymous principal with `forms:write` and a keyed hash of the client address. The form posts `formId`, the fields by name, the honeypot `website`, `_started` and `_proof`. A thrown error maps to 403 (site closed: limit reached or suspended), 400 (unknown or malformed form) or 503 with the request id (`apps/web/src/lib/server/form-post.ts`). A page with a form is served `no-store`, so every visitor gets a fresh timing token.

## From submission to supporter

An accepted submission stores a `submissions` row (the only copy of the address, with `list` and `consentTextVersion` as the visitor saw them) and publishes `newsletter.subscribed` with `confirmed: false` in the same transaction. If the address has neither a projection nor a live reservation, a seat is reserved in `supporter_admissions` (a hash of tenant and address) after `withinLimit` on `supporters.max`. After commit the outbox delivers the event to two subscribers:

- `mailing.confirmation` builds the double opt-in mail in the submission's locale with a link to `/confirm?token=...` on the tenant's primary hostname and sends it once ([mail.md](mail.md)). The token carries tenant id, submission id, list and expiry, never the address.
- `supporters.ingest` appends the event to the supporter's log, folds the projection and releases the reserved seat in the same transaction ([supporters.md](supporters.md)).

Opening the link only reads (`mailing.opt_in.get`); the button on that page posts to `mailing.opt_in.confirm`, which calls `SubmissionRepository.confirm` and, for the first confirmation only, publishes `consent.given`. A link scanner therefore confirms nothing.

## Retention

Rate-limit and cooldown windows live in `rate_limits` and are deleted by the hourly `rate_limits.sweep` job as `mycel_janitor` once older than a day (`packages/db/src/infra/janitor.ts`); that is why no cooldown may exceed a day. A seat reservation stops counting after seven days and is swept by the tenant's next `reserve`.

## Constants

| Constant                        | Value             | Where                                       | Why                                                                  |
| ------------------------------- | ----------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `RATE_LIMITS.perIp`             | 10 per 10 min     | `packages/core/src/forms/spam.ts`           | visible 429 for a flood from one address                             |
| `RATE_LIMITS.perIpUnproven`     | 3 per hour        | `packages/core/src/forms/spam.ts`           | stricter bucket for posts without a proof, on top of `perIp`         |
| `CONFIRMATION_COOLDOWN_SECONDS` | 24 h              | `packages/core/src/forms/spam.ts`           | one confirmation mail per address per form, silently                 |
| `MAX_TOKEN_AGE_MS`              | 24 h              | `packages/core/src/forms/spam.ts`           | an older timing token is invalid                                     |
| `minFillSeconds`                | default 3, max 60 | `packages/core/src/forms/model.ts`          | faster than this is treated as a bot                                 |
| `PROOF_MAX_NUMBER`              | 100 000           | `packages/core/src/forms/proof.ts`          | search space; about 0.6 s on a throttled CPU                         |
| `PROOF_TTL_MS`                  | 24 h              | `packages/core/src/forms/proof.ts`          | as long as a timing token, so a page left open for a day still posts |
| proof reuse cooldown            | 24 h              | `packages/core/src/forms/service.ts`        | one use per solution while the challenge lives                       |
| `WAIT_MS`                       | 2 s               | `apps/web/static/_form/proof.js`            | longest a submit waits for the solution before posting without       |
| `MAX_COOLDOWN_SECONDS`          | 24 h              | `packages/core/src/forms/ports.ts`          | the hourly sweep keeps a day of windows                              |
| `KEEP`                          | 1 day             | `packages/db/src/infra/janitor.ts`          | rate-limit window retention                                          |
| `ADMISSION_WINDOW_MS`           | 7 days            | `packages/core/src/supporters/ports.ts`     | a signup whose event never arrived must not hold a seat forever      |
| `CONFIRM_TTL_MS`                | 14 days           | `packages/core/src/mailing/confirmation.ts` | lifetime of a confirmation link                                      |
