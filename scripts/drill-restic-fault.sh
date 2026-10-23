#!/bin/sh
# A restic that cannot list the erasures snapshots and does everything else (TODO #29B, review of
# PR #39). The drill mounts it in front of the real one, so `restore erasures latest` meets the
# provider fault the review reproduced: the full snapshots readable, the register's list not. The
# restore has to stop there; loading only the full snapshot would bring an erased person back.
# Rejected: a fault switch in restore-erasures.sh itself (test code in the production image).
case " $* " in
  *" snapshots "*mycel,erasures*)
    echo 'Fatal: unable to list snapshots (drill fault)' >&2
    exit 1
    ;;
esac
exec /usr/bin/restic "$@"
