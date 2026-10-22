#!/bin/sh
# First start of the compose.yml Postgres (docker-entrypoint-initdb.d, runs once on an empty
# volume): the schema owner `mycel` as an ordinary role, not the image's superuser. Migrations,
# the CLI and the worker run as this owner, so a path that silently leans on superuser rights
# fails in CI instead of on a customer's box (TODO #18a; the lesson of upsertTenant and #20b).
# `createrole` because migrate creates and administers mycel_app, mycel_auth and the worker roles.
# The superuser (POSTGRES_USER, password PG_SUPERUSER_PASSWORD) stays inside this container.
# Rejected: POSTGRES_USER=mycel, which makes the owner a superuser.
set -eu
: "${MYCEL_DB_PASSWORD:?MYCEL_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_password="$MYCEL_DB_PASSWORD" <<'SQL'
create role mycel with login nosuperuser createrole password :'owner_password';
create database mycel owner mycel;
SQL
