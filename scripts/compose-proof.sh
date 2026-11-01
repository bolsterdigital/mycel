#!/bin/sh
# The compose proof (TODO #18a): compose.yml on an empty system, checked from outside through
# Caddy and from inside the network. CI job `compose` runs it after building mycel:ci; locally:
#
#   docker build -t mycel:ci . && scripts/compose-proof.sh
#
# It starts the stack with compose.ci.yml and compose.ci.env, runs `mycel blob init` and
# `mycel setup`, asserts, and stops at the first failure with the logs. `KEEP=1` leaves the stack
# running afterwards; otherwise it is removed with its volumes, so every run starts empty.
# Rejected: the assertions inline in verify.yml, which a developer cannot run before pushing.
set -eu

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-mycel-proof}"
dc() {
  docker compose --env-file compose.ci.env -f compose.yml -f compose.ci.yml --profile local-s3 "$@"
}
HTTPS_PORT=18443
failures=0

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] || [ "$failures" -ne 0 ]; then dc logs --no-color --tail 200 || true; fi
  [ "${KEEP:-0}" = 1 ] || dc down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

ok() { echo "ok   $1"; }
fail() {
  echo "FAIL $1" >&2
  failures=$((failures + 1))
}
# expect <description> <expected> <actual>
expect() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1: expected '$2', got '$3'"; fi; }

# The HTTP status of https://<host><path> through Caddy, resolved to this machine.
# 000 when there is no HTTP answer at all (a refused TLS handshake).
outside() {
  curl -sk -o /dev/null -w '%{http_code}' --max-time 10 \
    --resolve "$1:$HTTPS_PORT:127.0.0.1" "https://$1:$HTTPS_PORT$2" || true
}

dc down --volumes --remove-orphans >/dev/null 2>&1 || true
dc up -d --wait --wait-timeout 180

dc run --rm -T worker mycel blob init
dc run --rm -T worker mycel setup --tenant demo --name Demo --locales nl,en \
  --operator admin@example.test --hostname www.demo-site.test | tee /dev/stderr |
  grep -q '^admin: https://admin.example.test/admin/demo$' && ok 'mycel setup' || fail 'mycel setup'
dc run --rm -T worker mycel setup --tenant demo --name Demo --locales nl,en \
  --operator admin@example.test --hostname www.demo-site.test |
  grep -q '^nothing changed$' && ok 'mycel setup is idempotent' || fail 'mycel setup rerun'

# From outside, through Caddy (on-demand certificate after Caddy asked the application).
expect 'site /healthz via Caddy' 200 "$(outside demo.example.test /healthz)"
expect 'admin origin /healthz via Caddy' 200 "$(outside admin.example.test /healthz)"
expect '/internal/* closed' 404 \
  "$(outside demo.example.test '/internal/hostnames/allowed?domain=demo.example.test')"
expect '/readyz closed on sites' 404 "$(outside demo.example.test /readyz)"
expect '/metrics closed on sites' 404 "$(outside demo.example.test /metrics)"
expect 'API /healthz via Caddy' 200 "$(outside api.example.test /healthz)"
for path in /readyz /metrics /platform/tenants; do
  expect "API $path closed" 404 "$(outside api.example.test "$path")"
done
# An unknown name gets no certificate: the ask says no, so the TLS handshake fails.
expect 'no certificate for an unknown hostname' 000 "$(outside nope.example.test /healthz)"
# An unverified custom hostname gets none either (verification is DNS, which CI does not have).
expect 'no certificate for an unverified custom hostname' 000 \
  "$(outside www.demo-site.test /healthz)"

# What Caddy itself adds to a tenant page (scripts/quality/spec-checklist.json names these lines
# for compression, http3, http1-workarounds, https-tls and tls-configuration): compressed HTML,
# HTTP/2, HTTP/3 advertised, and no handshake below TLS 1.2. A missing path renders the full
# tenant 404 page, which is long enough for `encode` to compress, so no content is needed.
# HTTP/3 itself is not dialled: compose.ci.yml publishes TCP only.
page() {
  curl -sk -o /dev/null --max-time 10 --resolve "demo.example.test:$HTTPS_PORT:127.0.0.1" \
    "$@" "https://demo.example.test:$HTTPS_PORT/compose-proof-page" || true
}
expect 'page compressed with zstd' zstd \
  "$(page -H 'Accept-Encoding: zstd' -w '%header{content-encoding}')"
expect 'page compressed with gzip' gzip \
  "$(page -H 'Accept-Encoding: gzip' -w '%header{content-encoding}')"
expect 'page over HTTP/2' 2 "$(page --http2 -w '%{http_version}')"
case "$(page -w '%header{alt-svc}')" in
  *h3=*) ok 'HTTP/3 advertised in Alt-Svc' ;;
  *) fail 'HTTP/3 advertised in Alt-Svc: no h3 in Alt-Svc' ;;
esac
expect 'TLS 1.1 refused' 000 "$(page --tlsv1.0 --tls-max 1.1 -w '%{http_code}')"
expect 'TLS 1.3 accepted' 404 "$(page --tlsv1.3 -w '%{http_code}')"

# From inside the network: the ask route answers Caddy.
inside() {
  dc exec -T caddy wget -q -O /dev/null "http://web:3000/internal/hostnames/allowed?domain=$1" &&
    echo 200 || echo 404
}
expect 'ask allows the platform hostname' 200 "$(inside demo.example.test)"
expect 'ask allows the platform origin' 200 "$(inside admin.example.test)"
expect 'ask refuses an unknown hostname' 404 "$(inside nope.example.test)"

# Credentials per service (ADR 011 rule 1).
for svc in api web; do
  if dc exec -T "$svc" printenv DATABASE_URL >/dev/null 2>&1; then
    fail "$svc has DATABASE_URL"
  else ok "$svc has no DATABASE_URL"; fi
done
psql() { dc exec -T postgres psql -U mycel -d mycel -Atc "$1"; }
expect 'schema owner is no superuser' f "$(psql "select rolsuper from pg_roles where rolname = 'mycel'")"
expect 'every migration applied' "$(ls packages/db/migrations/*.sql | wc -l | tr -d ' ')" \
  "$(psql 'select count(*) from schema_migrations')"
expect 'worker /readyz' ok "$(dc exec -T worker node -e \
  "fetch('http://127.0.0.1:3000/readyz').then(async (r) => console.log(r.ok ? 'ok' : r.status + ' ' + (await r.text())))")"

# Self-service export (TODO #28): asked for as a site administrator would, built by the running
# worker with the image's own `tar`, and written to the bucket outside the media prefix.
expect 'tar in the runtime image' yes "$(dc exec -T worker sh -c 'tar --version >/dev/null && echo yes || echo no')"
expect 'export built by the worker' ready "$(dc exec -T worker node --input-type=module -e "
import { createRuntime } from '@mycel/api/compose';
import { exportArchiveKey, systemPrincipal, useCases } from '@mycel/core';
const rt = createRuntime(undefined, { service: 'proof' });
try {
  const demo = await rt.tenants.findBySlug('demo');
  const admin = systemPrincipal(demo.id, 'compose-proof');
  const { id } = await rt.invoker.run(useCases.requestExport, admin, {});
  let status = 'queued';
  for (let i = 0; i < 60 && (status === 'queued' || status === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    status = (await rt.invoker.run(useCases.listExports, admin, {})).exports.find((e) => e.id === id).status;
  }
  const head = await rt.blobs.head(exportArchiveKey(demo.id, id));
  console.log(status === 'ready' && head && head.size > 0 ? 'ready' : status);
} finally {
  await rt.close();
}" | tail -n 1)"

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo 'compose proof: all checks passed'
