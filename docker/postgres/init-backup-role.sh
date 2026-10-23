#!/bin/sh
# The backup login `mycel_backup` (TODO #18c, docker/backup/backup.sh): read-only on every table
# (pg_read_all_data) and BYPASSRLS, because under forced RLS with every tenant policy bound to
# mycel_app no other role sees all rows, the owner included (0018). It can read everything and
# write one thing: which erasure registrations its snapshot holds, `insert` on erasure_backups
# (0021, TODO #29B). Migration 0021 grants that where the login exists; this grants it where the
# login comes later. Only the superuser can grant BYPASSRLS, which is why this runs here and not
# in a migration. Runs once on an empty volume (docker-entrypoint-initdb.d) and is idempotent, so a box
# installed before this file existed runs it by hand (docs/self-hosting.md § Backups):
#
#   docker compose exec postgres sh /docker-entrypoint-initdb.d/20-backup-role.sh
#
# Without MYCEL_BACKUP_PASSWORD it creates nothing and says so; backup.sh then refuses to start.
# Rejected: BYPASSRLS on the owner (ADR 002 rule 4), and backups as the superuser (write access to
# everything for a job that only reads).
set -eu

if [ -z "${MYCEL_BACKUP_PASSWORD:-}" ]; then
  echo "init-backup-role: MYCEL_BACKUP_PASSWORD is not set, no backup login created" >&2
  exit 0
fi

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname mycel \
  -v backup_password="$MYCEL_BACKUP_PASSWORD" <<'SQL'
select format('create role mycel_backup with login nosuperuser bypassrls password %L',
              :'backup_password')
where not exists (select from pg_roles where rolname = 'mycel_backup') \gexec
select format('alter role mycel_backup with login nosuperuser bypassrls password %L',
              :'backup_password') \gexec
grant pg_read_all_data to mycel_backup;
grant connect on database mycel to mycel_backup;
select 'grant insert on erasure_backups to mycel_backup'
where to_regclass('public.erasure_backups') is not null \gexec
SQL
