# ADR 000 - How decisions are recorded here

- **Status**: accepted
- **Date**: 2026-10-21

## Context

Most code in this repository is written by coding agents working from briefs. Code is cheap to produce and cheap to regenerate; what is expensive is a decision that leaks into the data model, the API contract or the tenancy model and then has to be unwound. Those decisions must be written down once, with the alternatives that were rejected, so that no session re-derives them and no agent quietly builds against a different assumption.

## Decision

- Every decision that is hard to reverse gets an ADR in `docs/adr/`, numbered, one file each. "Hard to reverse" means: it shapes the database schema, a public contract (HTTP, MCP, event envelope, block schema), the tenancy or security model, licensing, or the dependency policy.
- An ADR has: Status, Date, Context, Decision, Rejected alternatives, Consequences. Keep it short; a rejected alternative is one or two sentences, not an essay.
- Status is `proposed`, `accepted`, `superseded by NNN` or `deprecated`. An accepted ADR is never edited into a different decision: write a new one that supersedes it.
- Framework choices are **not** ADRs by themselves. ADR 001 makes them replaceable; ADR 008 records the current picks and the policy for changing them.
- A brief or TODO item that contradicts an accepted ADR is wrong until the ADR is superseded. Agents stop and flag it; they do not build around it.

## Consequences

- Session start for any non-trivial work: read `docs/adr/` first (it is short on purpose).
- The ADR set is the public, licensable part of the project's design; operational planning lives in the private planning sibling (`docs/plans`, see `docs/README.md`).
