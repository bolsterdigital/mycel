# Tenant export and the erasure register

A site (one tenant, ADR 017) leaves an installation as a directory or a `.tar` and arrives in another one with the same data, the same ids and the same files (TODO #18d, ADR 002 rule 5). The same archive is the way back after a site was lost on this installation. Export is never gated by an entitlement or a suspension (ADR 015 rule 7). The commands are in [`../self-hosting.md`](../self-hosting.md#export); the code is [`packages/db/src/export.ts`](../../packages/db/src/export.ts).

## Format

```
manifest.json
tables/<table>.ndjson     one line per row
media/tenants/<id>/...    every file in the blob store under the tenant's prefix
```

`manifest.json` holds `format` (`mycel-tenant-export/1`), `schemaVersion` (the last migration applied to the exporting database, such as `0019_erasures`), `mycelVersion`, `exportedAt`, the tenant (`id`, `slug`, `name`, `locales`, `defaultLocale`, the stored `entitlements` document and `status`), and per table and per media file the file name, the number of rows or bytes and a sha256. Per table it also lists the columns, so an import into a newer schema writes exactly those and lets later columns take their defaults. A later column that is `not null` without a default is derived on import the way its migration backfilled it (`DERIVED` in `packages/db/src/export.ts`): `form_submissions.list` and `consent_text_version` (0020) come from the form's definition. Such an import reports a fingerprint difference for that table, by design.

A row is Postgres's own `to_jsonb(row)`: timestamps with microseconds and their offset, `jsonb` as JSON, arrays as arrays, bigints as numbers. Lines are sorted by their text, so two exports of the same data are byte for byte equal. Ids are UUIDv7 and travel unchanged; that is what lets two installations exchange sites without collisions (ADR 002).

## What travels, in this order

`tenant_hostnames`, `forms`, `form_submissions`, `supporters`, `supporter_admissions`, `events`, `authors`, `sections`, `patterns`, `media`, `media_usages`, `content_items`, `content_revisions`, `content_item_locales`, `content_block_refs`, `tenant_memberships`, `api_keys`, `audit_log`, `erasures`. A table's foreign keys point at tables earlier in the list. The export reads them as `mycel_app` in the tenant's context, in one repeatable-read snapshot: it holds exactly what row level security shows that tenant, and nothing of another.

**The files come after the tables, and the archive is complete or not written** (TODO #29A, ADR 019 rule 8). Every file of every media row that is live in the table snapshot is in the archive (the keys `mediaKeys` in `packages/core/src/media/model.ts` gives that row). A media item deleted while the export runs still has its files, because `media.delete` removes them only 24 hours later (`MEDIA_PURGE_DELAY_MS`, [`media.md`](media.md#usages-and-deleting)). If a needed file is missing anyway, or the files are read more than 12 hours (half that delay) after the snapshot, the export fails with the media ids and leaves no directory and no `.tar` behind; a directory given as `--out` must be empty or absent. Files under the tenant's prefix without a live row travel too: a variant the register lost, or an upload that committed after the snapshot. The latter has no row in the archive, so after an import the orphan sweep removes it a day later.

Every table of the schema has its place in `TABLES` in `export.ts`: `export`, `operational` or `platform`. A migration that adds a table does not compile until it has one, and `export.conformance.test.ts` fails when the live catalog has a table with a `tenant_id` that is not placed. A new tenant table is therefore part of the export from the pull request that adds it.

Two tables change on the way:

- **Memberships** travel as the operator's address instead of this installation's operator id. Import invites that address as a pending operator, as `mycel setup` does; the person logs in again on the new installation.
- **Hostnames**: the platform hostname is the installation's own (`<slug>.<PLATFORM_DOMAIN>`), so the importing side makes a new one and skips the exported one. A custom hostname arrives unverified and not primary: DNS may point elsewhere, and the daily check or Check DNS in the admin verifies it once it answers here.

## What does not travel

| Not exported                                                    | Why                                                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `outbox`, `jobs`, `mail_sends`, `rate_limits`, `login_attempts` | Work in progress and counters of this installation, not the site's data; the new one starts its own. |
| `erasure_backups`                                               | Which of this installation's snapshots hold a registration; an import starts unsecured.              |
| `operators`                                                     | Accounts of people who log in here; a membership carries the address instead.                        |
| The `tenants` row                                               | It is in the manifest; import creates the tenant through the platform path, with its audit row.      |
| Secrets                                                         | API keys travel as their hashes only, as they are stored.                                            |

## Import

`mycel import <path> [--slug <slug>]` checks before it writes anything: the format, every file against its sha256 and row count, that the export's schema is not newer than this database (`0020_x` into a database at `0019_erasures` is refused; older is fine, `migrate` already brought the database past it), and that neither the slug nor the tenant id exists here. Then it writes everything in one transaction: the event partitions for the exported months, the tenant as `mycel_platform` (audit row `platform.tenant.import`), every table as `mycel_app` in the tenant's context (row level security refuses a row of any other tenant), and the media files last. A failure anywhere rolls the rows back and removes the files already written: a failed import leaves no half site.

Afterwards it reads the site back the way export does and compares every table with the manifest. Equal except by design: the platform hostname, the verification of custom hostnames, and the one audit row of the import itself. It prints per table how many rows it imported and skipped, and exits non-zero on any other difference.

## Erasure register

Erasing a supporter (ADR 003 rule 5, ADR 019 rule 8) has two halves, so that the second can run again after a restore:

- **Register** (`ctx.erasures.register(supporterId, email)`, as `mycel_app`): one permanent row in `erasures` with the tenant, the supporter id, `erased_at`, the actor, and `email_hash`, the hex sha256 of `<tenant id>\n<lower-case address>`. Never the address. Nobody may update or delete a registration (migration 0019).
- **Apply** (`ctx.erasures.apply()`, `mycel erasures apply [--tenant <slug>]`): for every registration of the tenant, find the addresses (the supporter's projection and events by id, and any projection or submission value whose hash is registered), then: events and the projection become tombstones (`<supporter id>@erased.invalid`, empty props, empty lists; type and time stay, so every count still adds up); submissions that contain the address are deleted; outbox events that carry it are scrubbed, and the mail intents and `mail.reconcile` jobs of those events are deleted; jobs whose payload carries it are deleted. The audit log stays: it holds pseudonymous ids and keyed hashes only ([`audit.md`](audit.md)). Apply is idempotent and prints how many rows it changed; a second run changes none.

Apply needs rights `mycel_app` does not have (the event log is append-only for it), so it enters the role `mycel_erasure`, which may do exactly the above and only on the current tenant's rows. Only the schema owner may enter it: the worker and the CLI apply; a web request registers. The use case `supporters.erase` that registers and the projection that folds tombstones are the next step (TODO, phase 2).

**Secured** (TODO #29B, migration 0021): a registration lives in the database until a backup holds it, and a restore after losing the server would bring the person back with no register to say otherwise. So the backup records it: after a successful `restic backup`, the full run and the `erasures` run every 15 minutes insert one row per registration their snapshot holds into `erasure_backups` (tenant, supporter id, the restic snapshot id, `secured_at`); the backup login may insert there and write nowhere else. `ctx.erasures.status()` returns per tenant `registered`, `secured` and `oldestUnsecuredAt`; `mycel erasures status` prints it per site and exits with 1 when a registration has waited over an hour; `ops.status` shows the same as a warning. **A registration is a completed erasure only when it is secured.** The use case `supporters.erase` (phase 2) reports "done" on that, never on `register` alone. `erasure_backups` does not travel with an export: another installation's snapshots say nothing about this one's, so an imported registration starts unsecured.

**After a restore** of a snapshot, people erased since it was taken are back. `restore erasures latest` loads the register of the newest erasures snapshot and of the newest full snapshot into the restored database and `mycel erasures apply` erases them again, before the sites open ([`../self-hosting.md`](../self-hosting.md#restore), step 4). A snapshot list or register restic cannot read stops that step with an error instead of counting as no register. The restore drill rehearses this, including an erasure only the erasures snapshot holds and a restic that cannot list the erasures snapshots, and fails if an address is still in any table, any object key or `pg_dump --data-only`.
