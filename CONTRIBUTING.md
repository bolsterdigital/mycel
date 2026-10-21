# Contributing

Thanks for looking. This project is early; the most useful contributions right now are review of the [decisions](docs/adr/) and bug reports against them.

## Before you write code

1. Read `docs/adr/` (twenty short files). A change that contradicts an accepted ADR needs a new ADR first.
2. Read [`docs/architecture/overview.md`](docs/architecture/overview.md) for where things go and which packages may import which.

## From a fresh checkout to a working signup in five commands

Needs Node 22 and Docker (for Postgres only; the apps run on the host).

```sh
npm install
cp .env.example .env
npm run db:up       # Postgres 16 from compose.dev.yml, waits until it is healthy
npm run db:seed     # applies migrations, then creates tenant `probe` with a signup page
npm run dev         # API + outbox worker on :8787, web on :5173
```

Open <http://localhost:5173/probe/signup>, sign up, and the confirmation mail is printed in the `[api]` output; follow the link in it and the supporter's list moves from pending to confirmed (`POST /v1/supporters.get` shows both). `db:seed` is idempotent; run it again whenever you like.

**Logging in as an operator.** Without `OIDC_ISSUER` in `.env`, `npm run dev` also starts a mock IdP (`scripts/mock-oidc.mjs`, `[idp]` in the output). Open <http://localhost:5173/admin>: you land on its "sign in as" form with `admin@probe.test` filled in, the admin `db:seed` invited, and come back to the admin of tenant `probe`. Untick "Address verified" to see that an unverified address never claims an invitation. There you invite members and make API keys: the token is shown once, on the page after "create", and works as `Authorization: Bearer <token>` against the API on :8787 with the capabilities you ticked (never `tenant:admin`). The seed also stores `MYCEL_API_KEY` from `.env` as key `seed`, which the MCP server (`npm run mcp -w @mycel/mcp`) acts with; revoke it in the admin and the running MCP server stops on its next call.

This sequence was last run on 2026-10-21 on Linux with Docker Engine 29 and Compose v5: `db:up` on a machine whose 5432 was taken needed `MYCEL_PG_PORT=5435` in `.env` (and that port in both URLs), after which `db:seed` and a signup through the built web app, worker and confirmation link worked (the same path `npm run verify` drives end to end). On macOS, Docker Desktop was not usable that day; the Homebrew route below worked instead.

Without Docker, any Postgres 16 works: point `DATABASE_URL` in `.env` at a role that owns the database and may create roles (`CREATEROLE`), then skip `db:up`. On macOS that is `brew install postgresql@16`, `brew services start postgresql@16`, `createdb mycel`, and `DATABASE_URL=postgres://<your user>@localhost:5432/mycel` (Homebrew's superuser is your own account, no password). `db:up` publishes Postgres on `127.0.0.1:5432`; if that port is taken, set `MYCEL_PG_PORT` in `.env` and use the same port in `DATABASE_URL`, `APP_DATABASE_URL` and `AUTH_DATABASE_URL`.

Other scripts:

| Script               | What it does                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run db:migrate` | applies new migrations only (forward-only SQL in `packages/db/migrations`)                     |
| `npm run worker`     | runs the outbox worker and janitor on their own (`MYCEL_WORKER=off` keeps them out of the API) |
| `npm run verify`     | the gate, see below                                                                            |

## The gate

```sh
npm run verify
```

`verify` is the gate: formatting, dependency rules, types, tests, build and the Playwright + axe end-to-end tests. CI runs the same command. Keep it green on every commit.

With `DATABASE_URL` and `APP_DATABASE_URL` set (they are, after the steps above), `verify` also runs the database suites, including the Row Level Security conformance test (`packages/db/src/rls.conformance.test.ts`), and the end-to-end tests (after `npx playwright install chromium`). The end-to-end run starts the API with its worker on port 8797 (`E2E_API_PORT` to change it) and a console mailer that spools to a temporary directory, so the signup spec can follow the confirmation link. Without a database those suites skip; in CI (`E2E_REQUIRED=1`) a missing database fails the build instead. Load the env first: `set -a; . ./.env; set +a; npm run verify`.

## Container image

One image runs every process; the command picks which one:

```sh
docker build -t mycel .
docker run --env-file <your env file> -p 3000:3000 mycel web   # or: api | worker | migrate
```

The variables are the ones in `.env.example`. The image sets `NODE_ENV=production`, in which `MAILER=console` is refused, and `localhost` in a database URL means the container itself, not your machine.

Each process answers `GET /healthz` on `$PORT` (3000 in the image), which the image's `HEALTHCHECK` probes. CI builds the image on every pull request and checks that `api`, `web` and `worker` become healthy; it does not push it anywhere.

## Developer Certificate of Origin

We use the [DCO](https://developercertificate.org/) instead of a CLA. Sign off every commit:

```sh
git commit -s -m "..."
```

That adds `Signed-off-by: Name <email>` and certifies you have the right to contribute the change under the AGPL-3.0. Code written with an AI assistant is fine; you are the author and you sign.

## Conventions

- TypeScript strict, ESM, Prettier (2 spaces, single quotes, 100 columns).
- Config files and non-trivial modules open with a comment that says _why_, including the rejected alternative.
- Copy lives in i18n catalogs, never in components or services (ADR 007).
- Every use case gets a registry entry, a schema and a test; HTTP, MCP and UI follow from the registry (ADR 009).
- Public rendering must work without JavaScript; axe must pass (ADR 009).

## Reporting security issues

See [`SECURITY.md`](SECURITY.md).
