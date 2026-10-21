#!/bin/sh
# Container entrypoint: the first argument picks the process (see Dockerfile). `exec` hands PID 1
# to node so SIGTERM from the orchestrator reaches the shutdown handlers in server.ts/worker.ts.
# Rejected: `npm run <x>` as the command, which would put npm between the signal and node.
set -eu
cd /app

role="${1:-api}"
[ "$#" -gt 0 ] && shift

case "$role" in
  api) exec node packages/api/dist/server.js "$@" ;;
  worker) exec node packages/api/dist/worker.js "$@" ;;
  # adapter-node reads PORT and HOST; it listens on 0.0.0.0 by default.
  web) exec node apps/web/build/index.js "$@" ;;
  migrate) exec node packages/db/dist/migrate.js "$@" ;;
  *)
    echo "usage: <api|web|worker|migrate>, got: $role" >&2
    exit 64
    ;;
esac
