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
| `tenant_exports`                                                | Earlier archives of this site (below); an archive in an archive would grow with every export.        |
| `operators`                                                     | Accounts of people who log in here; a membership carries the address instead.                        |
| The `tenants` row                                               | It is in the manifest; import creates the tenant through the platform path, with its audit row.      |
| Secrets                                                         | API keys travel as their hashes only, as they are stored.                                            |

## Import

`mycel import <path> [--slug <slug>]` checks before it writes anything: the format, every file against its sha256 and row count, that the export's schema is not newer than this database (`0020_x` into a database at `0019_erasures` is refused; older is fine, `migrate` already brought the database past it), and that neither the slug nor the tenant id exists here. Then it writes everything in one transaction: the event partitions for the exported months, the tenant as `mycel_platform` (audit row `platform.tenant.import`), every table as `mycel_app` in the tenant's context (row level security refuses a row of any other tenant), and the media files last. A failure anywhere rolls the rows back and removes the files already written: a failed import leaves no half site.

Afterwards it reads the site back the way export does and compares every table with the manifest. Equal except by design: the platform hostname, the verification of custom hostnames, and the one audit row of the import itself. It prints per table how many rows it imported and skipped, and exits non-zero on any other difference.

## Self-service export

A site administrator (`tenant:admin`) asks for the same archive in the admin, at `/admin/<site>/export`, without the hoster (TODO #28, ADR 015 rule 7). It works while the site is suspended; it is the one action that does.

- **Ask**: the command `tenant.export` (effect `export`, requires `tenant:admin`: the archive holds members, API key hashes and the audit log, more than `supporters:export` covers). It writes a `queued` row in `tenant_exports` and plans the job `tenant.export` in one transaction. While one export of the site is queued or running, a second ask returns that one (a partial unique index, so a double click or an agent in a loop cannot have ten archives built). `tenant.export.list` shows the archives with status, who asked, size, sha256 and until when it can be downloaded; never where the file is. Both are HTTP routes and MCP tools; downloading is not.
- **Build**: the worker runs `exportTenant`, the code behind `mycel export`, into a temporary directory of its own and streams the `.tar` to the blob store under `exports/<tenant id>/<export id>.tar`. Not under `tenants/<id>/`: export reads that prefix as media, and the orphan sweep would delete the archive a day later. A run renews its job lease and the row's `heartbeat_at` every minute, so an export longer than the five-minute lease is not started twice; a run that finds a heartbeat older than a lease (its worker died) starts over. A failure marks the row `failed` with a scrubbed error and is not retried: the administrator asks again.
- **Download**: `GET /admin/<site>/export/<id>?exp=&sig=`, on the admin host only. It needs the operator's session, a membership of that site with `tenant:admin` at the moment of downloading (a member removed after asking gets nothing), a `ready` archive whose time has not run out, and a link signed for five minutes over `export:<tenant id>:<export id>:<exp>` (the admin page makes a fresh one on each load). Every refusal is the same 404. The response is `application/x-tar` as an attachment (`<slug>-<date>.tar`), `Cache-Control: private, no-store`, streamed from the store. Every download writes an audit row `tenant.export.download` with effect `export` and the export id as subject.
- **Lifetime**: an archive can be downloaded for `EXPORT_RETENTION_DAYS` (7 by default) after it was finished. The daily platform job `tenant.export.expire` works per tenant as `mycel_app`: it expires ready archives past their time or without their file (after a restore), deletes the files of expired and failed ones, and removes rows older than a year. Archives do not count towards `media.storage_max_bytes`: a limit never stands in the way of leaving.
- **Backups** leave `exports/` out (`rclone sync --exclude 'exports/**'` in `docker/backup/backup.sh`; the restore drill checks the snapshot). An archive is a derived copy with its own retention, and a snapshot would keep it beyond both that and an erasure. After a restore the rows come back without their files; the daily job marks them expired and the administrator asks for a new one.

## Erasure register

Erasing a supporter (ADR 003 rule 5, ADR 019 rule 8) has two halves, so that the second can run again after a restore:

- **Register** (`ctx.erasures.register(supporterId, email)`, as `mycel_app`): one permanent row in `erasures` with the tenant, the supporter id, `erased_at`, the actor, and `email_hash`, the hex sha256 of `<tenant id>\n<lower-case address>`. Never the address. Nobody may update or delete a registration (migration 0019).
- **Apply** (`ctx.erasures.apply()`, `mycel erasures apply [--tenant <slug>]`): for every registration of the tenant, find the addresses (the supporter's projection and events by id, and any projection or submission value whose hash is registered), then: events and the projection become tombstones (`<supporter id>@erased.invalid`, empty props, empty lists; type and time stay, so every count still adds up); submissions that contain the address are deleted; outbox events that carry it are scrubbed, and the mail intents and `mail.reconcile` jobs of those events are deleted; jobs whose payload carries it are deleted. Export archives (above) that may hold a registered person are expired: every `ready` or `running` one when the apply changed anything, and every one asked for before the newest registration; their error says "deleted after an erasure" and nothing about whom. `mycel erasures apply` deletes their files right after, the daily `tenant.export.expire` otherwise. The audit log stays: it holds pseudonymous ids and keyed hashes only ([`audit.md`](audit.md)). Apply is idempotent and prints how many rows it changed; a second run changes none.

Apply needs rights `mycel_app` does not have (the event log is append-only for it), so it enters the role `mycel_erasure`, which may do exactly the above and only on the current tenant's rows. Only the schema owner may enter it: the worker and the CLI apply; a web request registers. The use case `supporters.erase` that registers and the projection that folds tombstones are the next step (TODO, phase 2).

**Secured** (TODO #29B, migration 0021): a registration lives in the database until a backup holds it, and a restore after losing the server would bring the person back with no register to say otherwise. So the backup records it: after a successful `restic backup`, the full run and the `erasures` run every 15 minutes insert one row per registration their snapshot holds into `erasure_backups` (tenant, supporter id, the restic snapshot id, `secured_at`); the backup login may insert there and write nowhere else. `ctx.erasures.status()` returns per tenant `registered`, `secured` and `oldestUnsecuredAt`; `mycel erasures status` prints it per site and exits with 1 when a registration has waited over an hour; `ops.status` shows the same as a warning. **A registration is a completed erasure only when it is secured.** The use case `supporters.erase` (phase 2) reports "done" on that, never on `register` alone. `erasure_backups` does not travel with an export: another installation's snapshots say nothing about this one's, so an imported registration starts unsecured.

**After a restore** of a snapshot, people erased since it was taken are back. `restore erasures latest` loads the register of the newest erasures snapshot and of the newest full snapshot into the restored database and `mycel erasures apply` erases them again, before the sites open ([`../self-hosting.md`](../self-hosting.md#restore), step 4). The restore drill rehearses this, including an erasure only the erasures snapshot holds, and fails if an address is still in any table, any object key or `pg_dump --data-only`.
