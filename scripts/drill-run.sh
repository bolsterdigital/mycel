#!/bin/sh
# The restore drill (TODO #18c, docs/self-hosting.md § Restore): a backup of a populated box,
# restored onto an empty one, proven equal. CI runs it monthly and on pull requests that touch the
# backup (.github/workflows/restore-drill.yml); locally, after `npm ci` and a build:
#
#   docker build -t mycel:ci . && tsc -b packages/api && scripts/drill-run.sh
#
# 1. compose.yml as in production (non-superuser owner, migrate, RustFS), `mycel setup` for two
#    tenants, scripts/drill-fixture.mjs for their data, the fingerprint (scripts/drill-verify.mjs).
# 2. The backup service into a restic repository on the host (an export archive in the bucket
#    stays out of it, TODO #28): the older snapshot, held after its
#    dump while an unused image is deleted (TODO #29A: the purge waits, so the snapshot still has
#    its files and step 3 finds them). Then three runs that must fail without a snapshot: one held
#    while a second image is deleted and purged at once (scripts/drill-media.mjs), one held while
#    a third image loses its original and gains an unexpected file (same count, review of PR
#    #38), one over BACKUP_MAX_SECONDS. Three erasures runs (`backup erasures`), whose snapshots
#    the next full run's retention must leave alone. Then one supporter is erased
#    (scripts/drill-erase.mjs registers, `mycel erasures apply` applies) and a full backup is the
#    newer snapshot. Then a second supporter is erased and only the erasures backup runs (TODO
#    #29B): first with a wrong repository password (fails, nothing recorded, `mycel erasures
#    status` shows it unsecured), then twice for real (both secured, the second adds nothing, its
#    retention keeps the full snapshots). No full backup after that. Then `down --volumes`.
# 3. A fresh Postgres and bucket, the restore service as the owner with the older snapshot,
#    `migrate`; the clock runs from here. The fingerprint again, equal to the first.
# 4. The erasures again (TODO #18d and #29B, ADR 019 rule 8): `restore erasures latest` loads the
#    register of the newest erasures snapshot and of the newest full one, `mycel erasures apply`;
#    then neither address is in a table or an object key, `pg_dump --data-only` does not contain
#    them, and the event counts are unchanged. First the same command with a restic that cannot
#    list the erasures snapshots (scripts/drill-restic-fault.sh): it has to fail and load nothing.
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
# How many snapshots carry every tag of $1 (comma-separated).
tagged() {
  dc run --rm -T backup restic snapshots --host mycel --tag "$1" --json | tail -n 1 |
    node -e "let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => console.log(JSON.parse(d).length))"
}
# Rows in erasure_backups, read as the backup login (the owner sees none under forced RLS).
secured() {
  dc run --rm -T backup psql --no-psqlrc -Atc 'select count(*) from erasure_backups' | tail -n 1
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
# Three unused images for the media steps below; part of the fingerprint, as the older snapshot
# holds all three.
deleted=$(host node scripts/drill-media.mjs upload drill-a | tail -n 1)
purged=$(host node scripts/drill-media.mjs upload drill-a | tail -n 1)
masked=$(host node scripts/drill-media.mjs upload drill-a | tail -n 1)
# An export archive in the bucket (TODO #28): no snapshot may hold it, and an erasure removes it.
archive=$(host node scripts/drill-export.mjs drill-a)
host node scripts/drill-verify.mjs fingerprint >"$work/before.json"

step 'backup: the older snapshot, with an image deleted after the dump'
hold older
host node scripts/drill-media.mjs delete drill-a "$deleted"
release older
# The last line: `run` may print the image build first (pull_policy: build).
older=$(dc run --rm -T backup restic snapshots --host mycel --latest 1 --json | tail -n 1 |
  node -e "let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => console.log(JSON.parse(d).at(-1).short_id))")
echo "older snapshot: $older"
# The archive stays out of every snapshot: it is a copy with its own retention (TODO #28).
in_snapshot=$(dc run --rm -T backup restic ls "$older" | grep -c '/exports/' || true)
[ "$in_snapshot" = 0 ] || { echo "the snapshot holds $in_snapshot export path(s)" >&2; exit 1; }

step 'backup with an image purged after the dump: fails, no snapshot'
count=$(snapshots)
hold purged
host node scripts/drill-media.mjs delete drill-a "$purged"
host node scripts/drill-media.mjs purge drill-a "$purged"
if release purged; then echo 'the backup passed although files of a live image were gone' >&2; exit 1; fi
grep -q "media files missing for live assets.*$purged" "$work/purged.log" ||
  { echo "the failed backup does not name $purged" >&2; exit 1; }
[ "$(snapshots)" = "$count" ] || { echo 'the failed backup wrote a snapshot' >&2; exit 1; }

step 'backup with an original replaced by an unexpected file: fails, no snapshot'
hold masked
host node scripts/drill-media.mjs mask drill-a "$masked"
if release masked; then echo 'the backup passed although the original of a live image was gone' >&2; exit 1; fi
grep -q "media files missing for live assets.*$masked/original.png" "$work/masked.log" ||
  { echo "the failed backup does not name the original of $masked" >&2; exit 1; }
[ "$(snapshots)" = "$count" ] || { echo 'the masked backup wrote a snapshot' >&2; exit 1; }
# The image stays broken; gone, as an editor would remove it, so the newer snapshot can pass.
host node scripts/drill-media.mjs delete drill-a "$masked"
host node scripts/drill-media.mjs purge drill-a "$masked"

step 'backup over BACKUP_MAX_SECONDS: fails, no snapshot'
hold slow -e BACKUP_MAX_SECONDS=1
sleep 2
if release slow; then echo 'the backup passed although it ran over BACKUP_MAX_SECONDS' >&2; exit 1; fi
grep -q 'more than BACKUP_MAX_SECONDS=1' "$work/slow.log" ||
  { echo 'the slow backup failed for another reason' >&2; exit 1; }
[ "$(snapshots)" = "$count" ] || { echo 'the slow backup wrote a snapshot' >&2; exit 1; }

step 'erasures backups do not thin out the full snapshots, nor the full run theirs'
# Three erasures snapshots before the newer full one: a full run whose retention reached them
# would keep only the oldest and the newest of the day (restic --keep-daily).
for i in 1 2 3; do dc run --rm -T backup erasures; done
[ "$(tagged mycel,erasures)" = 3 ] || { echo 'three erasures runs did not leave three snapshots' >&2; exit 1; }

step 'erasure, then the newer full snapshot'
erased=supporter-drill-a@example.org
host node scripts/drill-erase.mjs drill-a "$erased"
dc run --rm -T worker mycel erasures apply
# The archive of drill-a held that supporter: the apply took it out of the bucket.
host node scripts/drill-export.mjs absent "$archive"
dc run --rm -T backup
dc run --rm -T backup restic snapshots --host mycel
[ "$(tagged mycel,erasures)" = 3 ] ||
  { echo "the full run's retention removed erasures snapshots" >&2; exit 1; }
full=$(tagged mycel,db)

step 'a second erasure, secured only by the erasures backup (TODO #29B)'
late=supporter-drill-b@example.org
host node scripts/drill-erase.mjs drill-b "$late"
dc run --rm -T worker mycel erasures apply
dc run --rm -T worker mycel erasures apply | tee "$work/apply-again.log"
grep -q '^erasures: 0 rows changed' "$work/apply-again.log" ||
  { echo 'a second erasures apply changed rows' >&2; exit 1; }
# A failed run: restic refuses the password, nothing is recorded, the status says so.
if dc run --rm -T -e RESTIC_PASSWORD=wrong backup erasures >"$work/wrong.log" 2>&1; then
  cat "$work/wrong.log"; echo 'the erasures backup passed with a wrong repository password' >&2; exit 1
fi
[ "$(secured)" = 1 ] || { echo "a failed erasures backup recorded registrations: $(secured)" >&2; exit 1; }
dc run --rm -T worker mycel erasures status | tee "$work/status.log"
grep -Eq '^drill-b[[:space:]]1 registered[[:space:]]1 not secured[[:space:]]oldest since ' "$work/status.log" ||
  { echo 'mycel erasures status does not show the unsecured registration' >&2; exit 1; }
# Then the run that works, twice: the second adds no row. Its retention keeps one erasures
# snapshot and leaves both full ones, so the older one is still there to restore.
dc run --rm -T -e ERASURES_KEEP_LAST=1 -e ERASURES_KEEP_DAILY=0 backup erasures
[ "$(secured)" = 2 ] || { echo "the erasures backup secured $(secured) of 2 registrations" >&2; exit 1; }
dc run --rm -T -e ERASURES_KEEP_LAST=1 -e ERASURES_KEEP_DAILY=0 backup erasures |
  tee "$work/again.log"
grep -q 'erasures: 2 in snapshot .*, 0 newly secured' "$work/again.log" ||
  { echo 'a second erasures backup did not report 0 newly secured' >&2; exit 1; }
[ "$(secured)" = 2 ] || { echo 'a second erasures backup added rows' >&2; exit 1; }
[ "$(tagged mycel,erasures)" = 1 ] || { echo 'the erasures retention kept more than one' >&2; exit 1; }
[ "$(tagged mycel,db)" = "$full" ] ||
  { echo "the erasures run's retention removed full snapshots" >&2; exit 1; }
dc run --rm -T worker mycel erasures status

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

step 'restore erasures latest with an unlistable register: fails, loads nothing'
# The review of PR #39: restic lists the full snapshots but not the erasures ones. A restore that
# took that for "no register yet" would load only the full snapshot and miss the late erasure.
if dc run --rm -T -v "$PWD/scripts/drill-restic-fault.sh:/fault/restic:ro" \
  -e PATH=/fault:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  restore erasures latest >"$work/restore-erasures-fault.log" 2>&1; then
  cat "$work/restore-erasures-fault.log" >&2
  echo 'restore erasures latest succeeded although the register could not be listed' >&2
  exit 1
fi
grep -q 'could not list the snapshots tagged mycel,erasures' "$work/restore-erasures-fault.log" ||
  { cat "$work/restore-erasures-fault.log" >&2; echo 'the fault failed the restore for another reason' >&2; exit 1; }
[ "$(dc run --rm -T backup psql --no-psqlrc -Atc 'select count(*) from erasures' | tail -n 1)" = 0 ] ||
  { echo 'the failed restore loaded registrations anyway' >&2; exit 1; }

step 'erasure after the restore'
erase_started=$(now)
dc run --rm -T restore erasures latest 2>&1 | tee "$work/restore-erasures.log"
dc run --rm -T worker mycel erasures apply
erase_done=$(now)
# Both sources: the erasures snapshot holds both registrations, the newer full one only the first.
grep -q 'erasures: 2 registration(s) in the snapshot, 2 new here' "$work/restore-erasures.log" ||
  { echo 'restore erasures latest did not load the erasures snapshot' >&2; exit 1; }
grep -q 'full: 1 registration(s) in the snapshot, 0 new here' "$work/restore-erasures.log" ||
  { echo 'restore erasures latest did not load the newer full snapshot' >&2; exit 1; }
for address in "$erased" "$late"; do
  host node scripts/drill-verify.mjs absent "$address" "$work/before.json" | tee -a "$work/compare.txt"
  left=$(dc run --rm -T backup sh -c "pg_dump --data-only | grep -ci '$address' || true" | tail -n 1)
  [ "$left" = 0 ] || { echo "pg_dump --data-only still holds $address $left time(s)" >&2; exit 1; }
done

step 'conformance'
host npx vitest run --project packages packages/db/src/rls.conformance.test.ts \
  packages/db/src/hostnames.test.ts

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
