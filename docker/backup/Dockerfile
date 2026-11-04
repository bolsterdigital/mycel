# The backup image (TODO #18c, ADR 008: Postgres on the box with restic backups): restic for the
# encrypted, deduplicated snapshots, the Postgres 16 client for pg_dump and pg_restore (the major of
# the compose Postgres), and rclone to copy an S3 bucket in and out. No Node and nothing of Mycel's
# own code: it reads the database and the bucket, so it never needs the application image.
#
#   docker compose --profile backup run --rm backup             # backup.sh
#   docker compose --profile restore run --rm restore [snapshot] # restore.sh, on an empty box
#
# Alpine by digest, the three tools by a floor (`>=`, TODO #179): the digest fixes the release, the
# floor is the version the scripts were written against, and the build takes whatever newer build
# that release ships. A stable Alpine moves its packages (rclone 1.74.1 became 1.75.2 inside 3.24
# on 2026-11-04) and drops the old version from its index the same day, so a pin that names one
# version (`=`, or `~` for its -rN rebuilds) breaks the build without anything having changed
# here, and did. The versions actually installed go into /usr/local/lib/mycel-backup/versions;
# the restore drill (scripts/drill/drill-run.sh, step "backup image") prints them and reports a
# tool above its floor as pin drift, apart from a build that fails for another reason. Raise the
# floors with the digest, after a green drill, from that file in the new image.
# Rejected: the official restic image plus apk adds on top (one more base to track), the
# application image (Node, the app's code and its credentials in the same container), and a
# floating Alpine tag (`alpine:3`), which lets a pull change the restic that wrote the repository.

FROM alpine:3.24.3@sha256:b3413572228e34bd1c9245f5565e6cd127005655e8a7899aef33d8e83255c9e6

# Quoted: unquoted, the shell reads `>=` as a redirect.
RUN apk add --no-cache \
      'restic>=0.18.1' \
      'rclone>=1.74.1' \
      'postgresql16-client>=16.15' \
      ca-certificates \
      openssh-client \
      tzdata \
 && mkdir -p /usr/local/lib/mycel-backup \
 && apk list -I restic rclone postgresql16-client \
      | sed -E 's/^([a-z0-9-]+)-([0-9][^ ]*) .*/\1 \2/' \
      | sort >/usr/local/lib/mycel-backup/versions \
 && [ "$(wc -l </usr/local/lib/mycel-backup/versions)" -eq 3 ]

ENV RESTIC_CACHE_DIR=/cache \
    STAGING_DIR=/staging

COPY backup.sh media-expected.sql restore.sh restore-erasures.sh common.sh entrypoint.sh \
     /usr/local/lib/mycel-backup/
WORKDIR /staging
ENTRYPOINT ["/usr/local/lib/mycel-backup/entrypoint.sh"]
CMD ["backup"]
