#!/bin/sh
# Carry the erasure register of a newer snapshot into a restored database (TODO #18d, ADR 019
# rule 8, docs/self-hosting.md § Restore):
#
#   restore-erasures.sh <snapshot>    # usually `latest`; via `run --rm restore erasures latest`
#
# A restore of an older snapshot brings back people who were erased after it was taken. Their
# registrations are in the newer snapshot's `erasures` table, which holds a hash of the address and
# never the address. This loads those rows into the restored database without touching anything
# else; `mycel erasures apply` (the worker image) then erases them again. Run it after `migrate`,
# so the table exists even when the restored snapshot is older than migration 0019.
#
# The rows go in as mycel_app, one tenant context at a time, because forced RLS binds the table to
# that role (0018, 0019); a tenant the restored database does not have is skipped (it was created
# after the restored snapshot, so none of its data came back either). Existing registrations stay.
# Rejected: `pg_restore --data-only --table=erasures` straight into the table (the owner sees no
# row under forced RLS, and a registration both snapshots hold would stop it at the first conflict).
set -eu
. /usr/local/lib/mycel-backup/common.sh

: "${PGPASSWORD:?set by compose.yml from MYCEL_DB_PASSWORD (the schema owner)}"
snapshot="${1:?name the snapshot whose register to load, usually latest}"
target=/restore-erasures
src="${target}${snapshot_path}"

q() { psql --no-psqlrc --tuples-only --no-align --command="$1"; }
[ "$(q "select to_regclass('public.erasures') is not null")" = t ] ||
  die "the database has no erasures table; restore and migrate first (docs/self-hosting.md § Restore)"

say "fetching the database dump of snapshot ${snapshot}"
rm -rf "$target"
restic restore "$snapshot" --host "$restic_host" --tag mycel --target "$target" \
  --include "${snapshot_path}/db"
[ -f "$src/db/mycel.dump" ] || die "snapshot ${snapshot} has no db/mycel.dump"

# The COPY block of that one table, aimed at a temporary table of the same shape.
pg_restore --data-only --table=erasures --file=- "$src/db/mycel.dump" |
  sed 's/^COPY public\.erasures /COPY pg_temp.erasures_incoming /' >"$target/erasures.sql"

psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 <<SQL
begin;
create temp table erasures_incoming (like public.erasures) on commit drop;
\\i ${target}/erasures.sql
reset search_path;
reset row_security;
grant select on pg_temp.erasures_incoming to mycel_app;
set local role mycel_app;
do \$\$
declare
  t uuid;
  n int := 0;
  k int;
begin
  for t in select distinct tenant_id from pg_temp.erasures_incoming
           where tenant_id in (select id from public.tenant_directory) loop
    perform set_config('app.tenant_id', t::text, true);
    insert into public.erasures select * from pg_temp.erasures_incoming where tenant_id = t
      on conflict do nothing;
    get diagnostics k = row_count;
    n := n + k;
  end loop;
  raise notice '[mycel-backup] % registration(s) in the snapshot, % new here, % for tenants this database does not have',
    (select count(*) from pg_temp.erasures_incoming), n,
    (select count(*) from pg_temp.erasures_incoming
       where tenant_id not in (select id from public.tenant_directory));
end \$\$;
commit;
SQL
rm -rf "$target"
say "done; now erase them again: docker compose run --rm worker mycel erasures apply"
