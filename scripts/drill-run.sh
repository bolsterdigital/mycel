#!/bin/sh
# The restore drill (TODO #18c, docs/self-hosting.md § Restore): a backup of a populated box,
# restored onto an empty one, proven equal. CI runs it monthly and on pull requests that touch the
# backup (.github/workflows/restore-drill.yml); locally, after `npm ci` and a build:
#
#   docker build -t mycel:ci . && tsc -b packages/api && scripts/drill-run.sh
#
# 1. compose.yml as in production (non-superuser owner, migrate, RustFS), `mycel setup` for two
#    tenants, scripts/drill-fixture.mjs for their data, the fingerprint (scripts/drill-verify.mjs).
# 2. The backup service into a restic repository on the host, then `down --volumes`.
# 3. A fresh Postgres and bucket, the restore service as the owner, `migrate`; the clock runs from
#    here. The fingerprint again, equal to the first; rls and hostnames conformance against the
#    restored database; then the worker, which has to report ready. Restore plus migrate plus
#    worker start is the measured RTO, written to the job summary.
#
# It stops at the first failure and prints the stack's logs. KEEP=1 leaves the restored stack.
# Rejected: the steps inline in the workflow, which a developer cannot run before pushing (the
# same reason as scripts/compose-proof.sh).
set -eu

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-mycel-drill}"
work=$(mktemp -d "${TMPDIR:-/tmp}/mycel-drill.XXXXXX")
export DRILL_RESTIC_DIR="$work/restic"
mkdir -p "$DRILL_RESTIC_DIR"
dc() {
  docker compose --env-file compose.ci.env -f compose.yml -f compose.ci.yml -f compose.drill.yml \
    --profile local-s3 --profile backup --profile restore "$@"
}

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then dc logs --no-color --tail 200 || true; fi
  [ "${KEEP:-0}" = 1 ] || dc down --volumes --remove-orphans >/dev/null 2>&1 || true
  # restic writes its repository as root inside the container.
  docker run --rm -v "$work:/work" alpine:3.24.3 rm -rf /work/restic >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

step() { echo "== $*"; }
now() { date +%s; }

# The host side reaches the stack on the drill's loopback ports, with the CI placeholders. Only
# through `host`: compose lets the shell environment win over --env-file, so an exported override
# would reach the containers too (a console mailer in production, which loadConfig refuses).
while IFS= read -r line; do
  case "$line" in '' | '#'*) continue ;; esac
  export "$line"
done <compose.ci.env
pg="127.0.0.1:${DRILL_PG_PORT:-55432}"
host() {
  env DATABASE_URL="postgres://mycel:${MYCEL_DB_PASSWORD}@$pg/mycel" \
    APP_DATABASE_URL="postgres://mycel_app:${MYCEL_APP_PASSWORD}@$pg/mycel" \
    AUTH_DATABASE_URL="postgres://mycel_authenticator:${MYCEL_AUTH_PASSWORD}@$pg/mycel" \
    DRILL_BACKUP_DATABASE_URL="postgres://mycel_backup:${MYCEL_BACKUP_PASSWORD}@$pg/mycel" \
    BLOB_S3_ENDPOINT="http://127.0.0.1:${DRILL_S3_PORT:-59000}" \
    MAILER=console PUBLIC_BASE_URL=http://127.0.0.1:4173 PLATFORM_DOMAIN=localhost \
    E2E_REQUIRED=1 "$@"
}

step 'populated box'
dc down --volumes --remove-orphans >/dev/null 2>&1 || true
dc up -d --wait --wait-timeout 180 postgres s3
dc run --rm -T worker mycel blob init
dc run --rm -T worker mycel setup --tenant drill-a --name 'Drill A' --locales nl,en \
  --operator admin@example.test --hostname www.drill-a.test
dc run --rm -T worker mycel setup --tenant drill-b --name 'Drill B' --locales nl \
  --operator editor@example.test
host node scripts/drill-fixture.mjs drill-a drill-b
host node scripts/drill-verify.mjs fingerprint >"$work/before.json"

step 'backup'
dc run --rm -T backup
dc run --rm -T backup restic snapshots --host mycel

step 'empty box'
dc down --volumes --remove-orphans
started=$(now)
dc up -d --wait --wait-timeout 180 postgres s3
[ "$(dc exec -T postgres psql -U mycel -d mycel -Atc "select count(*) from pg_class where relnamespace = 'public'::regnamespace")" = 0 ] ||
  { echo 'the new box is not empty' >&2; exit 1; }

step 'restore'
dc run --rm -T restore
dc run --rm -T migrate
restored=$(now)

step 'verify'
host node scripts/drill-verify.mjs fingerprint >"$work/after.json"
host node scripts/drill-verify.mjs compare "$work/before.json" "$work/after.json" | tee "$work/compare.txt"
[ "$(dc exec -T postgres psql -U mycel -d mycel -Atc "select rolsuper from pg_roles where rolname = current_user")" = f ]
host npx vitest run --project packages packages/db/src/rls.conformance.test.ts \
  packages/db/src/hostnames.conformance.test.ts

step 'worker'
worker_started=$(now)
dc up -d --wait --wait-timeout 120 worker
ready=$(dc exec -T worker node -e \
  "fetch('http://127.0.0.1:3000/readyz').then(async (r) => console.log(r.ok ? 'ok' : r.status + ' ' + (await r.text())))")
[ "$ready" = ok ] || { echo "worker /readyz: $ready" >&2; exit 1; }
worker_ready=$(now)

rto=$((restored - started + worker_ready - worker_started))
echo "restore drill passed: RTO ${rto}s (restore and migrate $((restored - started))s, worker $((worker_ready - worker_started))s)"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '## Restore drill'
    echo
    echo "| Measured | Seconds |"
    echo "| --- | --- |"
    echo "| Empty box to restored and migrated | $((restored - started)) |"
    echo "| Worker start to ready | $((worker_ready - worker_started)) |"
    echo "| **RTO** | **${rto}** |"
    echo
    echo "$(cat "$work/compare.txt")"
  } >>"$GITHUB_STEP_SUMMARY"
fi
