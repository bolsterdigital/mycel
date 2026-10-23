#!/bin/sh
# One backup run (TODO #18c, ADR 008, ADR 019 rule 8): the database and the media files in one
# restic snapshot, then the retention policy, and once a week a check that reads back part of the
# data. Run it on a schedule (docs/self-hosting.md § Backups); it exits non-zero at the first
# failure, so the scheduler's mail or log is the alarm.
#
# The dump runs as `mycel_backup`, a read-only login with BYPASSRLS that
# docker/postgres/init-backup-role.sh creates; compose hands it over as PGUSER and PGPASSWORD.
# The schema owner cannot take it: forced Row Level Security with every tenant policy bound to
# mycel_app (0018) hides every tenant row from the owner, and pg_dump then refuses rather than
# write an empty dump. Next to the dump goes roles.sql, the cluster roles the dump's
# grants and policies name (mycel_app, mycel_auth, ...), which no pg_dump contains and a restore
# on a new box has to create first. The staging directory is a volume: rclone then only fetches
# the media files that changed since the previous run.
# Rejected: dumping as the image's superuser (write access to everything for a job that reads),
# BYPASSRLS on the owner (ADR 002 rule 4, 0018), and the dump through `mycel_app` per tenant
# (misses the platform tables and gives no consistent snapshot across tenants).
set -eu
. /usr/local/lib/mycel-backup/common.sh

: "${PGPASSWORD:?set MYCEL_BACKUP_PASSWORD (docs/self-hosting.md § Backups)}"
[ "${PGUSER:-}" = mycel_backup ] || die "PGUSER must be mycel_backup, the read-only login, got ${PGUSER:-nothing}"
db="${STAGING_DIR}/db"
blob="${STAGING_DIR}/blob"
mkdir -p "$db" "$blob"

# Exit code 10 is restic's "repository does not exist"; anything else (12 is a wrong password, 1 a
# network or permission problem) must stop the run rather than try to create a second repository.
status=0
restic cat config >/dev/null 2>&1 || status=$?
case "$status" in
  0) ;;
  10)
    say "no repository at ${RESTIC_REPOSITORY} yet, initialising it"
    restic init
    ;;
  *)
    restic cat config >/dev/null || true
    die "cannot open the repository at ${RESTIC_REPOSITORY} (restic exit ${status})"
    ;;
esac

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
max_seconds="${BACKUP_MAX_SECONDS:-43200}"
case "$max_seconds" in '' | *[!0-9]*) die "BACKUP_MAX_SECONDS must be a number of seconds, got ${max_seconds}" ;; esac

# What the snapshot must hold (TODO #29A, ADR 019 rule 8): every media asset that is live now,
# with the number of files `mediaKeys` (packages/core/src/media/model.ts) gives it: one per
# variant, plus the private original unless a variant is named `file`. Read before the dump, in
# the same statement as t0 from the database's clock: an asset live here is in the dump, because
# `media.delete` purges only MEDIA_PURGE_DELAY_MS (24 hours) later. After rclone the same query
# would be useless: a purged asset has no row any more, which is exactly the case to catch.
# Rejected: the exact key list in SQL (duplicates EXTENSION_OF and FORMAT_OF from core), a node
# step in this image (Alpine without node, on purpose), and `pg_dump --snapshot` with a
# transaction held open while rclone runs (a snapshot open for hours, and a second session in sh).
expected="${STAGING_DIR}/media-expected.txt"
psql --no-psqlrc --quiet --tuples-only --no-align --field-separator=' ' \
  --set=ON_ERROR_STOP=1 --output="$expected" <<'SQL'
select 't0', extract(epoch from now())::bigint
union all
select tenant_id || '/' || id,
  (jsonb_array_length(variants)
    + case when variants @> '[{"name": "file"}]' then 0 else 1 end)::bigint
from media where deleted_at is null;
SQL
t0=$(sed -n 's/^t0 //p' "$expected")
[ -n "$t0" ] || die "could not read the start time from the database"

say "dumping the database"
pg_dump --format=custom --file="$db/mycel.dump.part"
mv "$db/mycel.dump.part" "$db/mycel.dump"
say "database: $(pg_restore --list "$db/mycel.dump" | grep -c ' TABLE DATA ') tables with data, $(du -sk "$db/mycel.dump" | cut -f1) KiB"

# `create role` for every mycel_* role but the owner and this backup login, then the memberships
# between them and the owner's; the owner becomes `current_user`, so a restore under another
# owner name works. The grant a non-superuser creator gets implicitly (admin option) is left out:
# `create role` on the new box makes it again. Options per membership as Postgres 16 stores them.
psql --no-psqlrc --quiet --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 --output="$db/roles.sql.part" <<'SQL'
with owner as (
  select pg_get_userbyid(datdba) as name from pg_database where datname = current_database()
), roles as (
  select oid, rolname from pg_roles
  where rolname like 'mycel\_%' and rolname <> 'mycel_backup'
    and rolname <> (select name from owner)
), statements as (
  select 1 as step, format(
    'do $$ begin if not exists (select from pg_roles where rolname = %L) then '
    'create role %I nologin; end if; end $$;', rolname, rolname) as stmt
  from roles
  union all
  select 2, format('grant %I to %s with inherit %s, set %s;', r.rolname,
    case when m.rolname = (select name from owner) then 'current_user'
         else quote_ident(m.rolname) end,
    am.inherit_option::text, am.set_option::text)
  from pg_auth_members am
  join roles r on r.oid = am.roleid
  join pg_roles m on m.oid = am.member
  where (m.rolname = (select name from owner) and not am.admin_option)
     or m.oid in (select oid from roles)
)
select stmt from statements order by step, stmt;
SQL
mv "$db/roles.sql.part" "$db/roles.sql"
say "roles: $(grep -c '^do ' "$db/roles.sql") roles, $(grep -c '^grant ' "$db/roles.sql") memberships"

# The restore drill holds the run here (scripts/drill-run.sh) to delete or purge media while a
# backup is under way. Unset in production.
if [ -n "${BACKUP_HOLD_AFTER_DUMP:-}" ]; then
  touch "${BACKUP_HOLD_AFTER_DUMP}.dumped"
  waited=0
  until [ -e "${BACKUP_HOLD_AFTER_DUMP}.go" ]; do
    [ "$waited" -lt 120 ] || die "held after the dump for 120 s without ${BACKUP_HOLD_AFTER_DUMP}.go"
    sleep 1
    waited=$((waited + 1))
  done
fi

blob_location
say "copying the media files from ${blobs}"
rclone sync "$blobs" "$blob" --fast-list
say "media files: $(tally "$blob")"

# A snapshot is either complete or not written. Past BACKUP_MAX_SECONDS (half the purge delay)
# an asset deleted after the dump may already be purged, so the guarantee no longer holds.
elapsed=$(psql --no-psqlrc --tuples-only --no-align \
  --command="select extract(epoch from now())::bigint - ${t0}")
[ "$elapsed" -le "$max_seconds" ] ||
  die "the run took ${elapsed} s, more than BACKUP_MAX_SECONDS=${max_seconds}; no snapshot written"
missing=""
while read -r asset count; do
  [ "$asset" = t0 ] && continue
  found=$(find "$blob/tenants/${asset%%/*}/media/${asset#*/}" -type f 2>/dev/null | wc -l | tr -d ' ')
  [ "$found" -ge "$count" ] || missing="${missing} ${asset#*/} (${found} of ${count})"
done <"$expected"
[ -z "$missing" ] ||
  die "media files missing for live assets, no snapshot written:${missing}"
say "media complete: $(($(wc -l <"$expected") - 1)) live assets"

cat >"${STAGING_DIR}/manifest.txt" <<EOF
started_at=${started}
last_migration=$(psql --no-psqlrc --tuples-only --no-align \
  --command='select max(version) from schema_migrations')
EOF

say "writing the snapshot"
restic backup --host "$restic_host" --tag mycel --tag db --tag blob "$snapshot_path"

say "applying the retention policy"
restic forget --host "$restic_host" --tag mycel --prune \
  --keep-daily "${BACKUP_KEEP_DAILY:-14}" \
  --keep-weekly "${BACKUP_KEEP_WEEKLY:-8}" \
  --keep-monthly "${BACKUP_KEEP_MONTHLY:-6}"

# Once a week (ISO weekday, 7 = Sunday) read back a random 5% of the data, so a repository that
# rots is noticed while older snapshots still exist; `always` checks on every run (the drill).
check_day="${BACKUP_CHECK_WEEKDAY:-7}"
if [ "$check_day" = always ] || [ "$(date -u +%u)" = "$check_day" ]; then
  say "checking the repository (5% of the data)"
  restic check --read-data-subset=5%
fi

say "done: $(restic snapshots --host "$restic_host" --tag mycel --json | grep -o '"short_id"' | wc -l | tr -d ' ') snapshots in the repository"
