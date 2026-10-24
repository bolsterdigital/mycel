# ADR 023 - Configurable forms, notifications and actions are baseline capabilities

- **Status**: accepted
- **Date**: 2026-10-24
- **Supersedes**: ADR 010 rule 2's exclusion of conditional logic in v1 and its rejection of conditional forms as a single future bundle; refines ADR 010 rules 1, 4 and 5 with an explicit action and notification contract
- **Preserves**: data-defined forms, server validation, HTML-first use, spam defence, double opt-in and separate transactional and bulk queues (ADRs 009, 010)

## Context

A useful ordinary form needs more than an e-mail field and one notification. Operators need to configure fields, conditional visibility, several routed notifications, a per-form response and connector feeds without commissioning code for every case. The prior small-v1 rule bundled practical conditional logic with uploads and a multipage builder even though those have different risks. The baseline is chosen for user capability, not an artificial development-effort cap.

## Decision

1. **Ordinary forms include a practical typed field vocabulary and bounded conditions.** The baseline covers text, e-mail, phone, number, date, choices, checkbox/consent, amount and hidden system fields, with localisable labels, help, errors and option text. Declarative predicates such as equals, not-equals and present may combine with bounded AND/OR groups for field visibility, requiredness and action eligibility. This is validated data, not arbitrary workflow code. Uploads and multipage flows are separate decisions and are not required merely because conditional forms are baseline.
2. **The server is authoritative.** The same versioned predicates used for the accessible progressive interface run during submission. A posted value for an inactive field is rejected or explicitly discarded according to a per-field policy stored in the definition; it never influences downstream actions, routing or consent. The decision and active field set are recorded with the submission. Native HTML forms work without JavaScript; enhancement may reveal fields and validate early without changing the result.
3. **Identity and history survive edits.** Every field and action has a stable id. A submission pins the validated form version and applicable action versions; changing a label, mapping, condition or template creates a new version and does not reinterpret old submissions or resend old messages. Definition changes are checked for broken field references and mappings before activation.
4. **A form can have multiple conditional actions.** Each action declares a trigger, predicate, enabled state, template or destination, field mapping and delivery status. Actions include internal notifications, a designated transactional autoresponse and connector feeds. An organisation can configure several independent notifications with distinct recipients and conditions on one form. Authoring a form, authoring a send action, publishing it, viewing submissions and exporting them use distinct capabilities, enforced by the same core use cases for UI, HTTP and MCP.
5. **Templates have explicit inheritance and local override.** Platform, tenant and per-form localised notification templates resolve to an effective preview that names each value's source. A higher-level edit cannot silently replace a local override. A template edit does not replay previous submissions. The configured recipient set or approved routing determines internal To/CC/BCC; visitor input cannot populate arbitrary recipients. An autoresponse uses only a designated validated address field, with verified sender, safe Reply-To, per-recipient caps and tenant quotas.
6. **A receipt is not marketing consent.** Transactional response and organisation notification may be planned on accepted submission; marketing subscription or connector delivery that requires double opt-in waits for confirmed evidence from the designated consent owner (ADR 024). The mandatory spam controls of ADR 010 remain: honeypot, minimum fill time, ALTCHA proof of work, per-IP and per-address limits, plus recipient limits, uniform bot-facing responses, visible real failures and separate sending reputation for transactional and bulk mail. Each effect gets a durable, deduplicated intent and runs through the outbox/reconciliation model of ADR 019, with visible attempts and controlled replay. Consent and suppression are checked at dispatch as well as replay.

## Rejected alternatives

- **One notification template per category or a universal global edit**: it cannot express per-form recipients and would silently change local behavior.
- **A visitor-selected e-mail recipient or free To/CC/BCC mapping**: it turns a public form into an open relay.
- **A general workflow language as the first form engine**: typed fields and bounded predicates cover ordinary routing with a smaller reviewable surface.
- **Deferring conditions because of a small-v1 effort target**: it would make basic operator autonomy a paid exception without reducing the need to design stable ids and delivery semantics.

## Consequences

- Form model, renderers, submission path and action editor need shared predicate fixtures and server/no-JavaScript conformance. Verify a 320px viewport and 200% zoom with the largest text setting, including multiple action buttons and conditionally revealed fields.
- Delivery tests cover repeated posts, confirmation gates, recipient routing, inactive fields, retries, paused destinations and suppression. This ADR is a contract; existing signup code does not imply these features are implemented.
