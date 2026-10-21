# Contributing

Thanks for looking. This project is early; the most useful contributions right now are review of the [decisions](docs/adr/) and bug reports against them.

## Before you write code

1. Read `docs/adr/` (twelve short files). A change that contradicts an accepted ADR needs a new ADR first.
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

Open <http://localhost:5173/probe/signup>, sign up, and the confirmation mail is printed in the `[api]` output. `db:seed` is idempotent; run it again whenever you like.

Without Docker, any Postgres 16 works: point `DATABASE_URL` in `.env` at a role that owns the database and may create roles (`CREATEROLE`), then skip `db:up`. Port 5432 must be free for `db:up`, so stop a local Postgres first or change the port in both files.

Other scripts:

| Script               | What it does                                                                         |
| -------------------- | ------------------------------------------------------------------------------------ |
| `npm run db:migrate` | applies new migrations only (forward-only SQL in `packages/db/migrations`)           |
| `npm run worker`     | runs the outbox worker on its own (set `MYCEL_WORKER=off` for the API to not run it) |
| `npm run verify`     | the gate, see below                                                                  |

## The gate

```sh
npm run verify
```

`verify` is the gate: formatting, dependency rules, types, tests, build and the Playwright + axe end-to-end tests. CI runs the same command. Keep it green on every commit.

With `DATABASE_URL` and `APP_DATABASE_URL` set (they are, after the steps above), `verify` also runs the database suites, including the Row Level Security conformance test (`packages/db/src/rls.test.ts`), and the end-to-end tests (after `npx playwright install chromium`). Without them those suites skip; in CI (`E2E_REQUIRED=1`) a missing database fails the build instead. Load the env first: `set -a; . ./.env; set +a; npm run verify`.

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
