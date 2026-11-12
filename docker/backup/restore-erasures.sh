#!/bin/sh
# Carry the newest erasure register into a restored database (TODO #18d and #29B, ADR 019 rule 8,
# docs/self-hosting.md § Restore):
#
#   restore-erasures.sh latest        # via `run --rm restore erasures latest`; always, after migrate
#   restore-erasures.sh <snapshot>    # the register of one given snapshot, full or erasures
#
# A restored snapshot can be up to a day old and bring back people erased after it was taken.
# Their registrations are in a newer snapshot: the erasures run (backup.sh erasures) writes one
# every 15 minutes, the full run once a day, and each holds the `erasures` table, a hash of the
# address and never the address; since 0050 also the person register (ADR 034), person ids only. `latest` loads both the newest erasures snapshot and the newest
# full one (whichever exists), so nothing depends on which of the two ran last; a given snapshot
# loads that one alone. It touches nothing else; `mycel erasures apply` (the worker image) then
# erases them again. Run it after `migrate`, so the table exists even when the restored snapshot
# is older than migration 0019.
#
# The rows go in as mycel_app, one tenant context at a time, because forced RLS binds the table to
# that role (0018, 0019); a tenant the restored database does not have is skipped (it was created
# after the restored snapshot, so none of its data came back either). Existing registrations stay.
# It reports per source how many registrations were new.
# Rejected: `pg_restore --data-only --table=erasures` straight into the table (the owner sees no
# row under forced RLS, and a registration both snapshots hold would stop it at the first conflict).
set -eu
. /usr/local/lib/mycel-backup/common.sh

: "${PGPASSWORD:?set by compose.yml from MYCEL_DB_PASSWORD (the schema owner)}"
snapshot="${1:?name the snapshot whose register to load, usually latest}"
target=/restore-erasures

q() { psql --no-psqlrc --tuples-only --no-align --command="$1"; }
[ "$(q "select to_regclass('public.erasures') is not null and to_regclass('public.person_erasures') is not null")" = t ] ||
  die "the database has no erasure registers; restore and migrate first (docs/self-hosting.md § Restore)"

# The newest snapshot with these tags, as a full id; empty only when restic answered with an empty
# list. Any other outcome stops the restore: a register restic could not list is not a register
# that does not exist, and loading only the older one would bring erased people back (review of
# PR #39). Not a pipeline: sh has no pipefail, so restic's exit status would be tail's.
newest() {
  listed=$(restic snapshots --host "$restic_host" --tag "$1" --latest 1 --json) ||
    die "could not list the snapshots tagged ${1}; nothing restored, fix the repository and run again"
  listed=$(printf '%s\n' "$listed" | tail -n 1)
  [ "$listed" = '[]' ] && return 0
  id=$(printf '%s\n' "$listed" | sed -n 's/.*"id":"\([0-9a-f]\{64\}\)".*/\1/p')
  [ -n "$id" ] || die "unreadable list of the snapshots tagged ${1}: ${listed}"
  echo "$id"
}

# Insert the rows of COPY script $2 into register $1 (erasures or person_erasures), one tenant
# context at a time as mycel_app; $3 names the source in the report (the supporter register's
# line keeps its wording, which the restore drill reads).
insert_register() {
  psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 <<SQL
begin;
create temp table ${1}_incoming (like public.${1}) on commit drop;
\\o /dev/null
\\i ${2}
\\o
-- pg_restore's preamble set these for the session; the rest runs with the defaults.
reset search_path;
reset row_security;
reset client_min_messages;
grant select on pg_temp.${1}_incoming to mycel_app;
set local role mycel_app;
do \$\$
declare
  t uuid;
  n int := 0;
  k int;
begin
  for t in select distinct tenant_id from pg_temp.${1}_incoming
           where tenant_id in (select id from public.tenant_directory) loop
    perform set_config('app.tenant_id', t::text, true);
    insert into public.${1} select * from pg_temp.${1}_incoming where tenant_id = t
      on conflict do nothing;
    get diagnostics k = row_count;
    n := n + k;
  end loop;
  raise notice '[mycel-backup] ${3}: % registration(s) in the snapshot, % new here, % for tenants this database does not have',
    (select count(*) from pg_temp.${1}_incoming), n,
    (select count(*) from pg_temp.${1}_incoming
       where tenant_id not in (select id from public.tenant_directory));
end \$\$;
commit;
SQL
}

# Load the registers of snapshot $1 into the database; $2 names the source in the report. Both
# registers: the supporter one (0019) and the person one (0050, ADR 034); a snapshot made before
# the person register existed holds none, which loads nothing for it.
load() {
  rm -rf "$target"
  mkdir -p "$target"
  say "fetching the registers of ${2} snapshot ${1}"
  restic restore "$1" --host "$restic_host" --tag mycel --target "$target" \
    --include "${snapshot_path}/db/mycel.dump" --include "${erasures_path}/erasures.copy" \
    --include "${erasures_path}/person-erasures.copy"
  if [ -f "${target}${erasures_path}/erasures.copy" ]; then
    # Written by backup.sh erasures with these columns, in this order.
    {
      echo 'COPY pg_temp.erasures_incoming (tenant_id, supporter_id, email_hash, erased_at, actor) FROM stdin;'
      cat "${target}${erasures_path}/erasures.copy"
      echo '\.'
    } >"$target/erasures.sql"
    : >"$target/person_erasures.sql"
    if [ -f "${target}${erasures_path}/person-erasures.copy" ]; then
      {
        echo 'COPY pg_temp.person_erasures_incoming (tenant_id, person_id, erased_at, actor) FROM stdin;'
        cat "${target}${erasures_path}/person-erasures.copy"
        echo '\.'
      } >"$target/person_erasures.sql"
    fi
  elif [ -f "${target}${snapshot_path}/db/mycel.dump" ]; then
    # The COPY block of each table, aimed at a temporary table of the same shape.
    # Two steps, not a pipe: a dump pg_restore cannot read has to stop the restore, not load nothing.
    for table in erasures person_erasures; do
      pg_restore --data-only --table="$table" --file="$target/${table}.dump.sql" \
        "${target}${snapshot_path}/db/mycel.dump" ||
        die "could not read the ${table} register from ${2} snapshot ${1}; nothing loaded from it"
      sed "s/^COPY public\.${table} /COPY pg_temp.${table}_incoming /" \
        "$target/${table}.dump.sql" >"$target/${table}.sql"
    done
  else
    die "snapshot ${1} has neither db/mycel.dump nor erasures.copy"
  fi
  insert_register erasures "$target/erasures.sql" "$2"
  insert_register person_erasures "$target/person_erasures.sql" "$2 person register"
  rm -rf "$target"
}

if [ "$snapshot" = latest ]; then
  # `|| exit`: a die inside $( ) ends only the subshell.
  register=$(newest mycel,erasures) || exit 1
  full=$(newest mycel,db) || exit 1
  [ -n "$register$full" ] || die "the repository has no snapshot to load a register from"
  if [ -n "$register" ]; then load "$register" erasures; else say "no erasures snapshot yet"; fi
  if [ -n "$full" ]; then load "$full" full; fi
else
  load "$snapshot" given
fi
say "done; now erase them again: docker compose run --rm worker mycel erasures apply"
