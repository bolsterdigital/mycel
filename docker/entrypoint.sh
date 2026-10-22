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
  # adapter-node reads PORT and HOST; it listens on 0.0.0.0 by default. Behind the reverse proxy
  # (MYCEL_TRUST_PROXY=1, required in production) it takes host, protocol and client address
  # from the x-forwarded-* headers the proxy sets (docs/reference/caddy/Caddyfile.example), so a
  # tenant hostname resolves (ADR 014) and the form-post origin check and IP hashing see the real
  # values. Without a proxy those headers are spoofable and stay ignored.
  web)
    if [ "${MYCEL_TRUST_PROXY:-0}" = "1" ]; then
      export PROTOCOL_HEADER="${PROTOCOL_HEADER:-x-forwarded-proto}"
      export HOST_HEADER="${HOST_HEADER:-x-forwarded-host}"
      export ADDRESS_HEADER="${ADDRESS_HEADER:-x-forwarded-for}"
      export XFF_DEPTH="${XFF_DEPTH:-1}"
    fi
    exec node apps/web/build/index.js "$@"
    ;;
  migrate) exec node packages/db/dist/migrate.js "$@" ;;
  *)
    echo "usage: <api|web|worker|migrate>, got: $role" >&2
    exit 64
    ;;
esac
