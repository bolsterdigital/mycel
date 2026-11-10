# Forms

How a visitor's signup becomes a stored submission, a confirmation mail and a supporter event. A form definition is validated data referenced from a page's form block (ADR 010); the module validates the posted values on the server, runs the spam defence that ADR 010 rule 5 makes mandatory, reserves a supporter seat (ADR 015 rule 3) and publishes `newsletter.subscribed` through the outbox (ADR 011). Code: `packages/core/src/forms/`, the double opt-in in `packages/core/src/mailing/confirmation.ts` and `packages/core/src/mailing/service.ts`. The confirmation mail's delivery is in [mail.md](mail.md); what the supporter module does with the events is in [supporters.md](supporters.md). Decisions: [ADR 010](../adr/010-forms-and-mailing-built-in.md), [ADR 023](../adr/023-configurable-forms-and-actions.md).

## The definition

`FormDefinition` (`forms/model.ts`) supports signup, contact, petition and RSVP forms. Fields have stable ids, typed values and bounded conditions for activity and requiredness. Every form has one always-active required e-mail field; a signup also has a consent field. The server evaluates conditions over validated active values, discards or rejects inactive input according to the definition, and retains the exact definition and decisions in the submission. Labels, the submit label and the thank-you text are localised maps (`localized()`, see [i18n.md](i18n.md)).

| Field                | Content                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`                 | UUID                                                                                                                    |
| `kind`               | `signup`, `contact`, `petition`, `rsvp`                                                                                 |
| `list`               | the consent scope a signup joins (ADR 010 rule 6), `^[a-z0-9][a-z0-9-]{0,62}$`                                          |
| `fields`             | Email, text, textarea, phone, number, amount, date, choice, multiple-choice, checkbox, consent and hidden system fields |
| `consentTextVersion` | which consent text the visitor saw; copied onto the submission and the events                                           |
| `minFillSeconds`     | minimum seconds between rendering and submitting, 0 to 60, default 3                                                    |

Conditions use equals, not-equals and present atoms, optionally grouped by bounded AND/OR. Field conditions refer to earlier fields and cannot derive consent from hidden, inactive or invalid input. Native rendering keeps conditional fields reachable without JavaScript; conditional requiredness is enforced on the server. With JavaScript, progressive enhancement reveals active fields and updates requiredness using the same predicates; submission validation remains authoritative. Connector feeds use the versioned registry contract below (ADRs 023, 024).

## Ports

`forms/ports.ts` adds form, submission, rate-limit and private action repositories to the transaction context:

| Port                   | Methods                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FormRepository`       | `findById`, `list`, `insert`, `save(base, value)`: compare-and-swap definition updates                                                                                      |
| `SubmissionRepository` | `insert`, `findById`, `list(formId)`, `findByFeedBusinessId`, `confirm(id, at)`: one conditional update, true only for the call that set `confirmedAt`                      |
| `RateLimiter`          | `hit(key, { max, windowSeconds })`: fixed-window counter; `cooldown(key, seconds)`: sliding window of one that records only a success, refused above `MAX_COOLDOWN_SECONDS` |

`FormFeedRepository` and `FormMailRepository` read and compare-and-swap private versioned configuration; mail settings also reserve the tenant mail budget.

The rate limiter runs in the use case's transaction, so a refusal must commit: `form.submit` returns a `rejected` result instead of throwing.

## Use cases

- **`form.get`** (`forms:read`) returns the definition plus a fresh signed timing token (`startedToken`) and a proof-of-work challenge for rendering it publicly.
- **`form.submit`** (`forms:write`, `consumes: 'supporters.max'`) returns `accepted` with a submission id, `invalid` with field errors as i18n keys, or `rejected` with a reason.

## Administration

`/admin/<tenant>/forms` lists and creates forms; `/admin/<tenant>/forms/<id>` edits their fields, bounded typed conditions, localised copy, reusable templates, notifications and feeds. Native forms call the registry with the same validation as HTTP and MCP. The detail screen also offers synthetic mail/feed previews, recent submission versions, delivery status and controlled mail replay. Private mail settings and connection settings are loaded only with their respective read capabilities.

`form.list` requires `content:write`. `form.create` and `form.update` require both `content:write` and `content:publish`, because these definitions are live. Updating requires the fingerprint returned by `form.get`; a stale definition is a conflict. The update rejects broken references in configured mail actions and feeds. Stored submission snapshots remain unchanged. `form.submission.list` requires `supporters:read` and returns the latest 100 submission identifiers, timestamps, confirmation states and pinned versions, without visitor values. Mail authoring, sending and connection configuration retain the separate capabilities described below.

## The order of checks in `form.submit`

For an anonymous principal (the public site) only, in this order: the honeypot must be present and empty (`honeypot`), the timing token must be valid and signed for this form (`token-invalid`) and old enough (`too-fast`), and a posted proof must verify (`proof-invalid`). A verified proof is used once: a `cooldown` on `forms.proof:<challenge>` for 24 hours refuses a second post of the same solution. An absent proof (no JavaScript) is not refused (ADR 009); the post is marked unproven.

Then, when the principal carries an IP hash (an anonymous visitor): the per-IP limit, and for an unproven post also the stricter per-IP unproven limit (`ip-limited`). Then field validation. Then, under the tenant's admission lock, the recipient cooldown on `forms.confirm:<form>:<sha256(tenant:email)>` (`recipient-limited`): at most one confirmation mail per address per form per day. A refusal at any step writes no submission, no event and no seat. Each refusal logs `form.submit.rejected` with a fixed reason, never the address.

The public `reason` is coarser than the log: honeypot, token and proof failures are all `spam`; `ip-limited` is `rate-limited`. The web front answers `spam` and `recipient-limited` with the same thank-you redirect as an accepted post, so neither a bot nor a third party learns anything; `rate-limited` is a visible 429.

## Proof of work

`forms/proof.ts` implements the ALTCHA v1 protocol with SHA-256. The server picks a salt and a secret number in `[0, maxNumber]`, sends `sha256hex(salt + number)` and signs form id, challenge and expiry with the `Signer`. `apps/web/static/_form/proof.js` searches for the number, writes the base64 solution into the hidden `_proof` field and waits at most two seconds before posting without one. `checkProof` answers `absent`, `invalid` (malformed, wrongly signed, expired, another form's, or not a solution) or `ok`.

## The public route

`apps/web/src/routes/(public)/[tenant]/[[locale=locale]]/[...path]/+page.server.ts` handles the native form post of a page (no JavaScript required). The tenant comes from the site being visited and the locale from the path; nothing in the body chooses either. The visitor is an anonymous principal with `forms:write` and a keyed hash of the client address. The form posts `formId`, the fields by name, the honeypot `website`, `_started` and `_proof`. A thrown error maps to 403 (site closed: limit reached or suspended), 400 (unknown or malformed form) or 503 with the request id (`apps/web/src/lib/server/public/form-post.ts`). A page with a form is served `no-store`, so every visitor gets a fresh timing token.

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

## Versioned ordinary fields

Definitions support `text`, `textarea`, `email`, `phone`, `number`, `date`, `choice`, `multiple-choice`, `checkbox`, `consent`, `amount` and server-owned `hidden` fields. Each field has a stable `id` independent of its posted `name`; reading a legacy definition initially assigns its original name as that id. Keep that id when renaming. Choice option values are stable keys with localised labels. Amounts are non-negative decimal values with at most two fractional digits; this field does not charge money. Signup, contact, petition and RSVP definitions use the same validation engine. A required, unconditional e-mail field identifies the submission. Only signup and petition with active checked consent emit a newsletter signup; contact and RSVP never implicitly subscribe.

`activeWhen` and `requiredWhen` accept `equals`, `not-equals` and `present`, or one `and`/`or` group of at most eight atoms. References point to earlier fields by id and comparisons must match their types. Missing, inactive or invalid values satisfy no predicate, including `not-equals`. Multiple-choice equality tests membership. Definitions reject duplicate ids/names, broken or forward references and invalid choice values. Hidden system values and consent cannot control another field.

The server evaluates in definition order over validated active values. An inactive field's default policy discards input; `inactivePolicy: reject` refuses a supplied nonempty value. Empty native controls are discarded under either policy. Neither discarded input nor invalid input can activate another field or supply marketing permission. A submission's `evaluation` stores its exact definition, version fingerprint, active/required field ids and discarded field ids. Confirmation reads the pinned e-mail field and consent, so edits never reinterpret the old submission. Historical rows have null evaluation and retain the established confirmation path; the migration does not invent historical decisions.

`form.get` returns a tenant-bound version fingerprint. Public forms post it as `_formVersion`; integrations can pass `formVersion` to `form.submit`. A stale fingerprint refuses the submission before effects. The fingerprint uses the canonical definition and the configured keyed hasher; rotating that key also invalidates open forms. Omitting the version preserves the existing integration contract and validates against the current definition. The snapshot, rather than the current fingerprint, is the durable evidence.

Native forms display all conditional controls and explanatory copy. Conditional controls omit native `required`, leaving authoritative validation to the server so an inactive required field never blocks submission. On a validation error the visitor's values, including multiple choices, are retained. No JavaScript is required; conditional hiding/enhancement and the authoring UI belong to the subsequent management surface. Honeypot, timing, proof of work, persistent IP and recipient caps still guard intake. Snapshot data is exported/imported with the submission and erased when that submission is erased; no extra copy or tenant table is introduced.

## Private mail templates and actions

`form.mail.get` (`mailing:read`) reads a tenant-private versioned document in `form_mail_settings`. It never appears in public `form.get`. `form.mail.update` requires `mailing:send`; a document with enabled forms also requires `content:publish`. It performs an optimistic version check and validates template references, field references and typed predicates against the tenant's forms. The table and its version travel with tenant export/import; the installation-local `form_mail_budget` does not.

Templates contain localised plain-text subject and body maps. Effective values resolve per locale and per property: a local override, then the selected tenant template, then platform catalog copy. `form.mail.test` (`mailing:read`) previews the same validated values and predicates without sending. Each value names its source (`local`, `tenant`, `platform`). `{{field:stable-id}}` substitutes an active validated field; missing/inactive values contribute nothing. Substituted subject values cannot introduce newlines; output length stays bounded. HTML is generated by escaping the resulting plain text. A confirmation keeps its mandatory platform link, fallback URL and ignore instructions. It cannot replace the consent owner or subscribe anyone itself.

A configuration supports up to eight independently conditional actions, each with a stable id, enable switch and template reference. A notification has one to eight distinct fixed approved recipients; each receives a separate message. A receipt has no configured recipient: its only destination is the form's validated active e-mail field. A signup that requires double opt-in uses the confirmation as its visitor response and does not add a receipt beside it. There is at most one receipt action per form. There is no free To, CC, BCC or Reply-To mapping from visitor input; the sender is the existing installation-configured sender.

After spam checks and the existing 24-hour per-form/address cooldown, acceptance pins each matching action's version, event id and recipient into the submission evaluation. Effective copy and routing are immutable `form.mail.planned` outbox events. The version covers the form version, action definition and referenced template, rather than interpolated visitor data. There is one stored event per accepted submission/action-version/recipient, and dispatch accepts only the event id pinned on that submission. A copied event with another id cannot obtain a new intent. Template edits plan no historical events and cannot change an accepted event's message. Configured confirmation copy and its version are pinned separately in the evaluation and the existing `newsletter.subscribed` event.

Acceptance reserves the action count against `mail.monthly_max` in a persistent atomic UTC calendar-month counter and enforces `mailing.enabled`. Retries consume no extra reservation; erasure does not refund one. A separate persistent per-recipient bucket caps form-action mail at twenty per hour in one tenant. The original IP limits, ALTCHA, timing token, honeypot, recipient cooldown and supporter admission limit remain in place. Quota failure rolls back the submission and its planned effects and is a visible real failure, rather than a false thank-you.

## Delivery status and controlled replay

The `forms.mail` subscriber and matching `MailSource` run through the existing [mail intent and reconciliation protocol](mail.md). They recheck tenant suspension, `mailing.enabled`, the saved submission/event binding, current form/action activation and current fixed recipient approval. A receipt still has only its validated designated address. Marketing consent is separate: the double opt-in source for new versioned submissions also checks erasure, prior confirmation and withdrawals in its consent scope before dispatch/reconciliation. A transactional receipt or internal notification does not grant or require marketing subscription consent.

`form.delivery.get` (`mailing:read`) returns pinned action versions, attempts, scrubbed errors and pending, in-flight, unknown, sent or abandoned state. `form.mail.replay` (`mailing:send`) schedules reconciliation of an existing pinned event. It cannot change its version, copy or recipient, reset an unknown attempt, resend a sent intent or revive an abandoned one. A disabled action sends nothing; resuming its configuration does not scan historical submissions. A deliberate replay after resuming still passes the source checks. The administration interface consumes these same registry functions.

Form-action events carry the submission address so the existing erasure chain finds their mail intents and reconcile jobs before removing complete personalised mail bodies. Free text, names and phone numbers disappear with those bodies; recognising only the address would leave personal copies behind. The submission evaluation disappears with the submission. A missing submission blocks even an old in-memory event from dispatch. Tenant A cannot load tenant B's settings, submission, action or intent. Exports preserve pinned history but do not replay installation-local outbox work on import.

## Versioned connector feeds

Private `form.feed.get`, `form.feed.update` and `form.feed.test` use the same registry through HTTP and MCP. Reading requires `connections:read`; authoring and rehearsal require `connections:configure`, and enabling any feed also requires `content:publish`. The private settings document has compare-and-swap versions. A feed names a stable id, form, connection and connection version, typed field-id mapping, optional predicate and consent scope. A missing connection can be saved only as disabled; reads include its current closed failure class. Public `form.get` never exposes this configuration.

The currently supported confirmation owner is Mycel. The scope must equal the signup or petition's list and be authorized by the connection, which must also authorize that form. External confirmation ownership and provider-specific suppression need a provider adapter; they are not silently simulated. `form.feed.test` evaluates supplied synthetic values with the same field, predicate, destination and author-authorization gates, returns the mapped active values, and always reports that confirmation is required. It writes no submission, consent or delivery. `connection.test` remains the separately authorized synthetic transport test.

An accepted submission pins each eligible feed, its mapping fingerprint, original author and opaque business id inside its evaluation snapshot. Only active, validated values can be mapped; forged inactive values cannot satisfy a condition or become exported fields. A template or mapping edit never enumerates old submissions or replans an effect. A confirmed submission's `consent.given` outbox event plans the existing connection intent, deduplicated by connection and pinned business id. Ingesting that event is idempotent, so subscriber execution order cannot lose the confirmed projection.

Immediately before delivery the source checks the submission still exists, its pinned mapping, current feed activation, original author's configure and publish rights, approved connection version, current confirmed scope and erasure register. An intervening withdrawal blocks an old submission even if a later, separate signup restored list membership. The source rebuilds only the approved mapped fields and consent evidence; jobs and connection intents contain no submitted values. Connection pause, rotation, destination changes, uncertainty, reconciliation and replay retain the existing [connection contract](connections.md). A blocked intent does not silently repin itself after configuration changes.

Migration 0043 stores private settings under forced tenant RLS. Settings and submission snapshots are portable; connection credentials, intents and attempts remain operational. A tenant import needs reconnection before feeds can run. Existing submission erasure removes the pinned feed together with its values; the connection inventory reports external-copy state without claiming to erase the receiver's copy. The form editor consumes this registry contract; provider-specific setup remains separate work.

Creation does not place a form on a public page. Contact and RSVP forms require `content:write`; signup and petition creation also require `content:publish`, because they can initiate opt-in. Every update of an existing definition also requires `content:publish`: published block trees refer to that definition directly. Mail action authoring remains `mailing:send` and feed authoring remains `connections:configure`. Publishing a page remains its separate content operation. There is no second form draft lifecycle.
