#!/bin/sh
# Shared by backup.sh, restore.sh and restore-erasures.sh: logging, the restic host, and where the media files live.
# Sourced, not run.

say() { echo "[mycel-backup] $*"; }
die() {
  echo "[mycel-backup] error: $*" >&2
  exit 1
}

: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY (docs/self-hosting.md § Backups)}"
: "${RESTIC_PASSWORD:?set RESTIC_PASSWORD (docs/self-hosting.md § Backups)}"

# One fixed host name for every snapshot: `docker compose run` gives each container a random
# hostname, and restic's `forget` groups by host, so without this no snapshot would ever expire.
restic_host=mycel
snapshot_path="${STAGING_DIR}"
# The erasures run's snapshot (backup.sh erasures, TODO #29B): its own path, so restic keeps its
# snapshots in a group of their own and the full run never carries a stale copy of it.
erasures_path=/erasures

# The media files as an rclone location: the bucket through an rclone remote built from the same
# BLOB_S3_* keys the application reads (rclone takes a remote from RCLONE_CONFIG_<NAME>_* in the
# environment), or the directory of BLOB_STORE=fs, which compose mounts at BLOB_DIR. Sets
# `blobs`; called directly, not in $( ), so the exports reach the rclone that runs next.
blob_location() {
  case "${BLOB_STORE:-s3}" in
    s3)
      : "${BLOB_S3_BUCKET:?set BLOB_S3_BUCKET}"
      export RCLONE_CONFIG_BLOB_TYPE=s3
      export RCLONE_CONFIG_BLOB_ACCESS_KEY_ID="${BLOB_S3_ACCESS_KEY_ID:?set BLOB_S3_ACCESS_KEY_ID}"
      export RCLONE_CONFIG_BLOB_SECRET_ACCESS_KEY="${BLOB_S3_SECRET_ACCESS_KEY:?set BLOB_S3_SECRET_ACCESS_KEY}"
      export RCLONE_CONFIG_BLOB_REGION="${BLOB_S3_REGION:-us-east-1}"
      if [ -n "${BLOB_S3_ENDPOINT:-}" ]; then
        export RCLONE_CONFIG_BLOB_PROVIDER=Other
        export RCLONE_CONFIG_BLOB_ENDPOINT="${BLOB_S3_ENDPOINT}"
      else
        export RCLONE_CONFIG_BLOB_PROVIDER=AWS
      fi
      if [ "${BLOB_S3_FORCE_PATH_STYLE:-0}" = 1 ]; then
        export RCLONE_CONFIG_BLOB_FORCE_PATH_STYLE=true
      else
        export RCLONE_CONFIG_BLOB_FORCE_PATH_STYLE=false
      fi
      blobs="blob:${BLOB_S3_BUCKET}"
      ;;
    fs)
      [ -d "${BLOB_DIR:-}" ] || die "BLOB_STORE=fs needs BLOB_DIR mounted into this container"
      blobs="${BLOB_DIR}"
      ;;
    *) die "BLOB_STORE must be s3 or fs, got ${BLOB_STORE}" ;;
  esac
}

# No rclone.conf: the only remote comes from the environment above.
rclone() { command rclone --config '' "$@"; }

# "<n> files, <k> KiB" under a local directory (BusyBox du has no byte count).
tally() {
  echo "$(find "$1" -type f | wc -l | tr -d ' ') files, $(du -sk "$1" | cut -f1) KiB"
}
