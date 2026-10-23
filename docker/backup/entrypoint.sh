#!/bin/sh
# Entrypoint of the backup image: the first argument picks the script, the rest goes to it. Any
# other command (restic, rclone, psql) runs as given, for inspecting a repository by hand:
# `docker compose --profile backup run --rm backup restic snapshots`.
set -eu
dir=/usr/local/lib/mycel-backup

case "${1:-backup}" in
  backup)
    [ "$#" -gt 0 ] && shift
    exec sh "$dir/backup.sh" "$@"
    ;;
  # `run --rm backup erasures`: only the erasure register, every 15 minutes (TODO #29B).
  erasures) exec sh "$dir/backup.sh" erasures ;;
  restore)
    shift
    # `run --rm restore erasures <snapshot>`: the register of a newer snapshot (TODO #18d).
    if [ "${1:-}" = erasures ]; then
      shift
      exec sh "$dir/restore-erasures.sh" "$@"
    fi
    exec sh "$dir/restore.sh" "$@"
    ;;
  *) exec "$@" ;;
esac
