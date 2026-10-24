# ADR 010 - Forms and mailing are built in; delivery and spam defence are bought or standardised

- **Status**: accepted
- **Date**: 2026-10-21
- **Rules 1, 2, 4 and 5 refined**: 2026-10-24 by [ADR 023](023-configurable-forms-and-actions.md). Conditional fields, multiple per-form notifications and connector actions are baseline; the original small-v1 exclusion of conditional logic is superseded.
- **Rule 6 partly superseded**: 2026-10-24 by [ADR 024](024-managed-integrations-and-external-ownership.md). The native suite remains available, but an external CRM or mail platform may permanently own a tenant's corresponding domain or consent scope.

## Context

Dreamkit chose WordPress largely for Gravity Forms and, later, Listmonk for lists. Both are good products; both own the domain they implement (field types, entries, subscribers, consent) in their own schema, outside the platform. With cheap code, a focused form system and a mailing system are weeks of work and remove two external systems from every tenant. What stays expensive is the undifferentiated, liability-heavy part: actually delivering mail to inboxes and keeping bots out.

## Decision

### Forms

1. **A form is a definition (fields, validation, consent texts, actions) stored as data and referenced from a block** (ADR 004). Submissions are stored per form with the validated payload and provenance (IP hash, user agent class, locale, page).
2. **A deliberately small field vocabulary**: short text, long text, e-mail, phone, number, single choice, multiple choice, checkbox (incl. consent), amount, date, hidden. No file uploads in v1; no conditional logic in v1. New field types are a registry entry with schema, renderer and tests.
3. **Four form kinds ship first, each a template over the same engine**: contact, signup (newsletter / petition / "keep me posted"), donation (one-off and recurring, ADR 005), event RSVP.
4. **Actions on submission are domain events** (`form.submitted`, `petition.signed`, `newsletter.subscribed`, ...). The supporter, mailing and donation modules subscribe (ADR 003). Notifications to the organisation are one more subscriber, not special-cased.
5. **Spam defence is built in and not optional**: honeypot, minimum fill time, ALTCHA proof-of-work, rate limits per IP and per e-mail address, double opt-in for anything that adds to a list. The house `formulieren-en-mail` checklist is the acceptance test.

### Mailing

6. **Lists, consent, segments, templates, campaigns and automations are Mycel's.** A list is a consent scope; membership is derived from consent events (ADR 003). Segments are stored filters over the supporter projection. Templates are the same block model as pages, rendered by an e-mail renderer to table-based HTML plus a text part.
7. **Sending is a port.** First adapter: Scaleway TEM (API plus webhooks for delivered/bounced/complained); second: generic SMTP. The sender adapter never decides _whether_ to send; the mailing domain does.
8. **Deliverability mechanics are non-negotiable and built once**: per-tenant sending domain or subdomain with SPF, DKIM and DMARC verified before the first send; `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058) on every bulk message; bounce and complaint events suppress the address; throughput limits per tenant; a warm-up schedule for new domains.
9. **Transactional mail (confirmations, donor links, operator notifications) and bulk mail share the renderer and the port but have separate queues and limits**, so a campaign can never delay a payment confirmation.
10. **Automations are small and explicit**: trigger (event type plus filter), optional delay, action (send template, add tag). No visual workflow builder in v1.

## Rejected alternatives

- **Keep Gravity Forms / Listmonk as services behind an API**: the sync problem the supporter registry was invented to work around; two more systems per tenant to run and upgrade.
- **Run a mail server ourselves (Postfix, Haraka)**: owning IP reputation is a full-time job and the thing most likely to take every tenant down at once. Delivery is the commodity we buy.
- **Full-featured form builder with conditional logic, file uploads, multi-page**: each feature is cheap to add and expensive to make accessible and secure; we add them one at a time when a tenant needs them.

## Consequences

- Form and e-mail renderers are two implementations of the block renderer interface; a11y gates (ADR 009) apply to both.
- The first vertical probe is a signup form posting to a page, emitting an event, and sending one confirmation through TEM test mode: it exercises every rule above.
- The Dreamkit `dreamkit-supporter-registry` consent service and TEM webhook handling are the reference implementation to port, not to call.
