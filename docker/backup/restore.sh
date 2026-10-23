#!/bin/sh
# Restore a snapshot onto an empty box (TODO #18c, docs/self-hosting.md § Restore):
#
#   restore.sh [snapshot]     # default: the latest snapshot of this installation
#
# Runs as the schema owner, an ordinary role: first the cluster roles from roles.sql (a new box has
# none of mycel_app, mycel_auth, ...), then pg_restore in one transaction with `--no-owner`, so
# every object belongs to whichever owner this box has, whatever the name was on the old one. The
# load works under forced RLS because pg_dump enables RLS in the post-data section, after the
# rows are in. Then the media files back into the bucket or directory. It refuses a database that
# already has tables: restoring over live data is never what a restore should do quietly.
#
# What it cannot do is the step after it: `migrate` lives in the application image. Start the
# stack afterwards (`docker compose up -d`), whose first service is `migrate`; the runner is
# idempotent and brings a dump from an older release up to this one.
# Rejected: `--clean` over an existing database (drops in dependency order are fragile with
# partitions and policies, and a half-restored live database is worse than a refusal).
set -eu
. /usr/local/lib/mycel-backup/common.sh

: "${PGPASSWORD:?set by compose.yml from MYCEL_DB_PASSWORD (the schema owner)}"
snapshot="${1:-latest}"
target=/restore
src="${target}${snapshot_path}"

q() { psql --no-psqlrc --tuples-only --no-align --command="$1"; }
owner=$(q 'select current_user')
[ "$(q "select rolsuper from pg_roles where rolname = current_user")" = f ] ||
  say "warning: ${owner} is a superuser; a restore as an ordinary owner is what the drill proves"
tables=$(q "select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')")
[ "$tables" = 0 ] ||
  die "the database already has ${tables} tables; restore needs an empty database (docs/self-hosting.md § Restore)"

say "fetching snapshot ${snapshot}"
rm -rf "$target"
restic restore "$snapshot" --host "$restic_host" --tag mycel --target "$target"
[ -f "$src/db/mycel.dump" ] || die "snapshot ${snapshot} has no db/mycel.dump"
say "snapshot: $(cat "$src/manifest.txt" | tr '\n' ' ')"

say "creating the roles"
psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --file="$src/db/roles.sql"
say "roles: $(grep -c '^do ' "$src/db/roles.sql") roles, $(grep -c '^grant ' "$src/db/roles.sql") memberships"

say "restoring the database as ${owner}"
pg_restore --dbname="${PGDATABASE:-mycel}" --no-owner --role="$owner" --single-transaction \
  --exit-on-error "$src/db/mycel.dump"
say "database: $(q "select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')") tables, last migration $(q 'select max(version) from schema_migrations')"

blob_location
say "copying the media files to ${blobs}"
case "$blobs" in blob:*) rclone mkdir "$blobs" ;; esac
mkdir -p "$src/blob"
rclone sync "$src/blob" "$blobs" --fast-list
say "media files: $(tally "$src/blob")"

rm -rf "$target"
say "done; now start the stack (docker compose up -d): migrate runs first"
