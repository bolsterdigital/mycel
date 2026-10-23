#!/bin/sh
# The restore drill (TODO #18c, docs/self-hosting.md § Restore): a backup of a populated box,
# restored onto an empty one, proven equal. CI runs it monthly and on pull requests that touch the
# backup (.github/workflows/restore-drill.yml); locally, after `npm ci` and a build:
#
#   docker build -t mycel:ci . && tsc -b packages/api && scripts/drill-run.sh
#
# 1. compose.yml as in production (non-superuser owner, migrate, RustFS), `mycel setup` for two
#    tenants, scripts/drill-fixture.mjs for their data, the fingerprint (scripts/drill-verify.mjs).
# 2. The backup service into a restic repository on the host: the older snapshot, held after its
#    dump while an unused image is deleted (TODO #29A: the purge waits, so the snapshot still has
#    its files and step 3 finds them). Then two runs that must fail without a snapshot: one held
#    while a second image is deleted and purged at once (scripts/drill-media.mjs), one over
#    BACKUP_MAX_SECONDS. Then one supporter is erased (scripts/drill-erase.mjs registers, `mycel
#    erasures apply` applies) and a second backup is the newer snapshot. Then `down --volumes`.
# 3. A fresh Postgres and bucket, the restore service as the owner with the older snapshot,
#    `migrate`; the clock runs from here. The fingerprint again, equal to the first.
# 4. The erasure again (TODO #18d, ADR 019 rule 8): the register of the newer snapshot
#    (`restore erasures latest`) and `mycel erasures apply`; then the address is in no table and
#    no object key, `pg_dump --data-only` does not contain it, and the event counts are unchanged.
# 5. rls and hostnames conformance against the restored database; then the worker, which has to
#    report ready. Restore, migrate, the erasure and the worker start are the measured RTO,
#    written to the job summary.
#
# It stops at the first failure and prints the stack's logs. KEEP=1 leaves the restored stack.
# Rejected: the steps inline in the workflow, which a developer cannot run before pushing (the
# same reason as scripts/compose-proof.sh).
set -eu

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-mycel-drill}"
work=$(mktemp -d "${TMPDIR:-/tmp}/mycel-drill.XXXXXX")
export DRILL_RESTIC_DIR="$work/restic"
export DRILL_HOLD_DIR="$work/hold"
mkdir -p "$DRILL_RESTIC_DIR" "$DRILL_HOLD_DIR"
# The backup container writes its `.dumped` marker here, whatever user it runs as.
chmod 777 "$DRILL_HOLD_DIR"
dc() {
  docker compose --env-file compose.ci.env -f compose.yml -f compose.ci.yml -f compose.drill.yml \
    --profile local-s3 --profile backup --profile restore "$@"
}

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then dc logs --no-color --tail 200 || true; fi
  [ "${KEEP:-0}" = 1 ] || dc down --volumes --remove-orphans >/dev/null 2>&1 || true
  # restic writes its repository as root inside the container.
  docker run --rm -v "$work:/work" alpine:3.24.3 rm -rf /work/restic /work/hold >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

step() { echo "== $*"; }
now() { date +%s; }

# A backup held after its dump (BACKUP_HOLD_AFTER_DUMP in docker/backup/backup.sh): `hold <name>
# [-e VAR=value ...]` starts it in the background and returns once the dump is written; `release
# <name>` lets it go on and returns its exit status, its output in $work/<name>.log. The first
# run builds the backup image, hence the long wait.
hold() {
  name=$1
  shift
  dc run --rm -T -e "BACKUP_HOLD_AFTER_DUMP=/hold/$name" "$@" backup >"$work/$name.log" 2>&1 &
  echo $! >"$work/$name.pid"
  waited=0
  until [ -e "$DRILL_HOLD_DIR/$name.dumped" ]; do
    kill -0 "$(cat "$work/$name.pid")" 2>/dev/null ||
      { cat "$work/$name.log" >&2; echo "backup $name ended before its dump was held" >&2; exit 1; }
    [ "$waited" -lt 600 ] || { echo "backup $name: no dump after 600 s" >&2; exit 1; }
    sleep 1
    waited=$((waited + 1))
  done
}
release() {
  touch "$DRILL_HOLD_DIR/$1.go"
  status=0
  wait "$(cat "$work/$1.pid")" || status=$?
  cat "$work/$1.log"
  return "$status"
}
snapshots() {
  dc run --rm -T backup restic snapshots --host mycel --json | tail -n 1 |
    node -e "let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => console.log(JSON.parse(d).length))"
}

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
# Two unused images for the media steps below; part of the fingerprint, as the older snapshot
# holds both.
deleted=$(host node scripts/drill-media.mjs upload drill-a | tail -n 1)
purged=$(host node scripts/drill-media.mjs upload drill-a | tail -n 1)
host node scripts/drill-verify.mjs fingerprint >"$work/before.json"

step 'backup: the older snapshot, with an image deleted after the dump'
hold older
host node scripts/drill-media.mjs delete drill-a "$deleted"
release older
# The last line: `run` may print the image build first (pull_policy: build).
older=$(dc run --rm -T backup restic snapshots --host mycel --latest 1 --json | tail -n 1 |
  node -e "let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => console.log(JSON.parse(d).at(-1).short_id))")
echo "older snapshot: $older"

step 'backup with an image purged after the dump: fails, no snapshot'
count=$(snapshots)
hold purged
host node scripts/drill-media.mjs delete drill-a "$purged"
host node scripts/drill-media.mjs purge drill-a "$purged"
if release purged; then echo 'the backup passed although files of a live image were gone' >&2; exit 1; fi
grep -q "media files missing for live assets.*$purged" "$work/purged.log" ||
  { echo "the failed backup does not name $purged" >&2; exit 1; }
[ "$(snapshots)" = "$count" ] || { echo 'the failed backup wrote a snapshot' >&2; exit 1; }

step 'backup over BACKUP_MAX_SECONDS: fails, no snapshot'
hold slow -e BACKUP_MAX_SECONDS=1
sleep 2
if release slow; then echo 'the backup passed although it ran over BACKUP_MAX_SECONDS' >&2; exit 1; fi
grep -q 'more than BACKUP_MAX_SECONDS=1' "$work/slow.log" ||
  { echo 'the slow backup failed for another reason' >&2; exit 1; }
[ "$(snapshots)" = "$count" ] || { echo 'the slow backup wrote a snapshot' >&2; exit 1; }

step 'erasure, then the newer snapshot'
erased=supporter-drill-a@example.org
host node scripts/drill-erase.mjs drill-a "$erased"
dc run --rm -T worker mycel erasures apply
dc run --rm -T backup
dc run --rm -T backup restic snapshots --host mycel

step 'empty box'
dc down --volumes --remove-orphans
started=$(now)
dc up -d --wait --wait-timeout 180 postgres s3
[ "$(dc exec -T postgres psql -U mycel -d mycel -Atc "select count(*) from pg_class where relnamespace = 'public'::regnamespace")" = 0 ] ||
  { echo 'the new box is not empty' >&2; exit 1; }

step 'restore the older snapshot'
dc run --rm -T restore "$older"
dc run --rm -T migrate
restored=$(now)

step 'verify'
host node scripts/drill-verify.mjs fingerprint >"$work/after.json"
host node scripts/drill-verify.mjs compare "$work/before.json" "$work/after.json" | tee "$work/compare.txt"
[ "$(dc exec -T postgres psql -U mycel -d mycel -Atc "select rolsuper from pg_roles where rolname = current_user")" = f ]

step 'erasure after the restore'
erase_started=$(now)
dc run --rm -T restore erasures latest
dc run --rm -T worker mycel erasures apply
erase_done=$(now)
host node scripts/drill-verify.mjs absent "$erased" "$work/before.json" | tee -a "$work/compare.txt"
left=$(dc run --rm -T backup sh -c "pg_dump --data-only | grep -ci '$erased' || true" | tail -n 1)
[ "$left" = 0 ] || { echo "pg_dump --data-only still holds the address $left time(s)" >&2; exit 1; }

step 'conformance'
host npx vitest run --project packages packages/db/src/rls.conformance.test.ts \
  packages/db/src/hostnames.conformance.test.ts

step 'worker'
worker_started=$(now)
dc up -d --wait --wait-timeout 120 worker
ready=$(dc exec -T worker node -e \
  "fetch('http://127.0.0.1:3000/readyz').then(async (r) => console.log(r.ok ? 'ok' : r.status + ' ' + (await r.text())))")
[ "$ready" = ok ] || { echo "worker /readyz: $ready" >&2; exit 1; }
worker_ready=$(now)

rto=$((restored - started + erase_done - erase_started + worker_ready - worker_started))
echo "restore drill passed: RTO ${rto}s (restore and migrate $((restored - started))s, erasure $((erase_done - erase_started))s, worker $((worker_ready - worker_started))s)"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '## Restore drill'
    echo
    echo "| Measured | Seconds |"
    echo "| --- | --- |"
    echo "| Empty box to restored and migrated | $((restored - started)) |"
    echo "| Erasure register carried over and applied | $((erase_done - erase_started)) |"
    echo "| Worker start to ready | $((worker_ready - worker_started)) |"
    echo "| **RTO** | **${rto}** |"
    echo
    echo "$(cat "$work/compare.txt")"
  } >>"$GITHUB_STEP_SUMMARY"
fi
