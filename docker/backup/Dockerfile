# The backup image (TODO #18c, ADR 008: Postgres on the box with restic backups): restic for the
# encrypted, deduplicated snapshots, the Postgres 16 client for pg_dump and pg_restore (the major of
# the compose Postgres), and rclone to copy an S3 bucket in and out. No Node and nothing of Mycel's
# own code: it reads the database and the bucket, so it never needs the application image.
#
#   docker compose --profile backup run --rm backup             # backup.sh
#   docker compose --profile restore run --rm restore [snapshot] # restore.sh, on an empty box
#
# Alpine by digest; the packages with `~` (any -rN build of that upstream version), because Alpine
# removes the previous -rN from its index on every rebuild of a package, so an exact `=` pin breaks
# the build without anything having changed upstream. Bump the digest and the three versions
# together, from `apk list restic rclone postgresql16-client` in the new image.
# Rejected: the official restic image plus apk adds on top (one more base to track), and the
# application image (Node, the app's code and its credentials in the same container).

FROM alpine:3.24.3@sha256:b3413572228e34bd1c9245f5565e6cd127005655e8a7899aef33d8e83255c9e6

RUN apk add --no-cache \
      restic~0.18.1 \
      rclone~1.74.1 \
      postgresql16-client~16.15 \
      ca-certificates \
      openssh-client \
      tzdata

ENV RESTIC_CACHE_DIR=/cache \
    STAGING_DIR=/staging

COPY backup.sh media-expected.sql restore.sh restore-erasures.sh common.sh entrypoint.sh \
     /usr/local/lib/mycel-backup/
WORKDIR /staging
ENTRYPOINT ["/usr/local/lib/mycel-backup/entrypoint.sh"]
CMD ["backup"]
