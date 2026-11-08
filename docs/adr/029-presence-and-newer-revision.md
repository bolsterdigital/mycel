# ADR 029 - Presence is a short-lived report per tab; a newer revision is a notice

- **Status**: accepted
- **Date**: 2026-11-08
- **Refines**: ADR 018 rule 2 (optimistic concurrency), the rule of TODO #17b that every command leaves one audit row
- **Builds on**: ADR 002 (forced RLS), ADR 009 (one registry for every front, HTML first), ADR 011 (cross-tenant work through a dedicated role), ADR 026 (a save on an older base merges)

## Context

Since ADR 026 two people saving at once no longer lose each other's work, but they only find out at saving. Editors rarely write together; they often look together, in a training or while helping someone on a call. A notice of who is there, and of a newer revision, is most of what they need. Locks are out: a WordPress-style lock stays behind when a browser closes and has to be taken over. Realtime editing stays out as well (afslag A6).

## Decision

1. **Presence is a report per browser tab, and it expires.** An open edit screen reports every 20 seconds on `content.presence.update` with a session id of the tab and its state: `viewing`, or `editing` when the tab has unsaved input. A report older than 70 seconds does not count. There is no leave call, no lock and nothing to take over; a closed laptop disappears by itself. The time is three beats plus the minute a browser may hold back the timers of a background tab. A tab that is hidden and has no input stops reporting; a hidden tab with unsaved input keeps reporting, because that is the one that can still save.

2. **The same answer carries the newer revision.** Given the `baseRevisionId` of the screen, the answer names the newest revision when it is another one, with its actor. A tab without input offers to load it; a tab with input is told that saving will merge (ADR 026). Neither is a conflict, and nothing is reloaded under someone's hands. `content.presence.list` reads the same answer without reporting, for the first render without JavaScript.

3. **Presence leaves no audit row and no history.** `content.presence.update` is a command that is exempt from the audit rule, by name, in the closed list `UNAUDITED_COMMANDS`. A row per tab every twenty seconds would be precisely the record of who read what and when that this feature must not create. The registry rules refuse an entry with an effect or a limit. Rows live in the unlogged table `content_presence`, are not exported, and are deleted after ten minutes by `mycel_janitor` in the hourly `rate_limits.sweep`.

4. **Presence is visible to whoever may read the item, on that site only.** Both use cases require `content:read` and look up the item first, so another site's id is a plain not-found; the table has forced RLS. An API key or agent may report and read like any other principal, and is shown under its key's label. A report is keyed by actor, item and session, so a guessed session id cannot overwrite someone else's row.

5. **One line per actor.** The asker's own tab is left out and their other tabs are shown as themselves, because two windows of one account can overwrite each other too. An actor with several tabs is `editing` if any of them is.

## Rejected alternatives

- **A query that writes**: it would tell MCP clients a write is read-only, and leave no room to guard it.
- **An in-memory map**: the web app, the API and MCP are separate processes.
- **Server-sent events or a websocket**: a long-lived connection per open tab for a notice that may be twenty seconds late.
- **Reloading a clean tab by itself**: someone reading the page, or about to type, has it replaced mid-sentence; loading is one click.

## Consequences

- Without JavaScript the screen shows who was present when it was rendered, and reports nothing; ADR 026 still protects the save.
- A suspended tenant cannot report (`guardSuspended` refuses commands) and the screen stops polling; it can still read the list.
- `apps/web/.../content/[itemId]/presence` is the browser's route to the use case; the API and MCP get theirs from the registry.
- A member's name or address is visible to other readers of the item for as long as they have it open, as it already is on the revision that member saved.
