# Self-hosting Mycel

From an empty server to the first login with [`compose.yml`](../compose.yml): one box, Docker Compose, Postgres on the box and Caddy in front with automatic certificates. Nothing here needs anything outside this repository. CI runs this same stack on an empty runner on every pull request (`scripts/compose-proof.sh`, job `compose`), so what this page describes is tested, apart from the real DNS and the real certificates.

## What you need

- **A Linux server** with Docker Engine and Docker Compose v2, ports 80 and 443 reachable, in a data centre whose jurisdiction you are happy with (ADR 002 asks for the EU). Two vCPUs and 4 GB of memory carry a small installation.
- **A domain for the sites** (`PLATFORM_DOMAIN`, say `sites.example.org`): every tenant gets `<slug>.sites.example.org`. It needs a wildcard record `*.sites.example.org` (`A`, and `AAAA` if the server has IPv6) pointing at the server.
- **Two more names** pointing at the server: the platform origin, where the admin lives (`PUBLIC_BASE_URL`, say `https://admin.example.org`), and the HTTP API (`API_HOST`, say `api.example.org`).
- **An S3-compatible bucket** for media (any provider; private, no public access), or the `local-s3` profile below for a bucket on the same box.
- **An OIDC issuer** for operator login (any OpenID Connect provider with authorization code and PKCE; a confidential or public client with redirect URI `<PUBLIC_BASE_URL>/admin/callback`). Without one the public sites work and the admin answers 503.
- **Scaleway Transactional Email** credentials and a sending domain with SPF, DKIM and DMARC (docs/reference/mail.md). Confirmation mails go out through it; it is the only delivery adapter so far.

## Install

1. Get the files at a release: `git clone https://github.com/bolsterdigital/mycel && cd mycel`, then check out the release you run. Compose reads `compose.yml` and mounts `docker/postgres/init-owner.sh` and `docker/caddy/Caddyfile` from this checkout.
2. `cp .env.example .env` and fill it in. Required on a server: the "Production" section at the bottom (`MYCEL_DB_PASSWORD`, `PG_SUPERUSER_PASSWORD`, `ACME_EMAIL`, `API_HOST`, and `MYCEL_IMAGE` pinned to the release), plus `MYCEL_APP_PASSWORD`, `MYCEL_AUTH_PASSWORD`, `SIGNING_SECRET`, `AUDIT_HASH_KEY`, `PUBLIC_BASE_URL`, `PLATFORM_DOMAIN`, `MAIL_FROM`, `TEM_SECRET_KEY`, `TEM_PROJECT_ID`, the `BLOB_S3_*` keys and the `OIDC_*` keys. Generate every password and key with `openssl rand -hex 32`: the passwords end up in connection URLs, so they must be URL-safe. The database URL lines at the top of `.env.example` are for development; compose builds its own from the passwords.
3. `docker compose up -d`. Postgres starts and creates the schema owner, `migrate` runs once, then `api`, `web`, `worker` and `caddy` start. `docker compose ps` shows them healthy within a minute.
4. Create the first site and its first operator:

   ```sh
   docker compose run --rm worker mycel setup --tenant demo --name "Demo" --locales nl,en \
     --operator you@example.org --hostname www.example.org
   ```

   It creates tenant `demo` on `demo.<PLATFORM_DOMAIN>`, invites `you@example.org` as administrator, adds `www.example.org` as a custom domain and prints the DNS records that domain needs, then the admin URL. `--hostname` is optional. Running it again with the same arguments changes nothing and says so; it never asks a question, so it can be scripted.

5. Log in at `<PUBLIC_BASE_URL>/admin` with your OIDC account under exactly the invited address. The invitation becomes your membership at that first login.

## What runs, and with which credentials

Each process gets only the database login it needs (ADR 011 rule 1):

| Service    | What it does                                                                                                 | Database login                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `postgres` | Postgres 16; on the first start creates the schema owner `mycel`, an ordinary role without superuser rights. | its own superuser, used by nothing after the first start                                         |
| `migrate`  | Applies the forward-only migrations, sets the passwords of the two runtime logins, exits.                    | the owner                                                                                        |
| `api`      | The HTTP API and `/openapi.json` on `API_HOST`.                                                              | `mycel_app` (tenant data under Row Level Security) and `mycel_authenticator` (keys and sessions) |
| `web`      | The public sites, the admin and the certificate check Caddy asks.                                            | the same two                                                                                     |
| `worker`   | Delivers outbox events, sends mail, runs scheduled jobs; also where `mycel` and `mcp` run.                   | the owner, plus the two                                                                          |
| `caddy`    | TLS and routing (`docker/caddy/Caddyfile`).                                                                  | none                                                                                             |

Neither `api` nor `web` has the owner's `DATABASE_URL`; a flaw in either cannot bypass tenant isolation through it. Caddy answers 404 from outside for `/internal/*`, `/readyz` and `/metrics` on every site, and for `/readyz`, `/metrics` and `/platform/*` on the API host; those are for the compose network only.

## Certificates and custom domains

Caddy gets a certificate the first time a name is requested, after asking `web` whether the name belongs to this installation: the platform origin, a platform hostname or a verified custom domain. A name nobody added never gets one. A custom domain is added with `mycel setup --hostname` or in the admin under the site's domains, and is verified through a TXT record; how that works, what an apex domain needs and how a domain is withdrawn: [`docs/reference/hostnames.md`](reference/hostnames.md). The API host gets an ordinary certificate at start.

## Storage

Media go to the bucket in `BLOB_S3_*`; the database holds only their metadata. For a single box without a provider, the `local-s3` profile runs an S3-compatible store (RustFS) next to the rest:

```sh
# .env: BLOB_S3_ENDPOINT=http://s3:9000, BLOB_S3_FORCE_PATH_STYLE=1, BLOB_S3_BUCKET=mycel,
#       BLOB_S3_ACCESS_KEY_ID and BLOB_S3_SECRET_ACCESS_KEY of your choice
docker compose --profile local-s3 up -d
docker compose run --rm worker mycel blob init   # creates the bucket once
```

The bucket then lives on the same disk as the database: a lost disk loses both, and a backup has to take both (§ Backups). An external bucket at a provider is the advice for anything that matters.

## The command line

`docker compose run --rm worker mycel <command>`; `mycel` without arguments prints the list. Besides `setup` and `blob init` it creates tenants, sets their entitlements and status, and lists and recovers stuck work: [`docs/reference/platform-api.md`](reference/platform-api.md) § The CLI. `mycel version` prints the version of the image.

## MCP

The image's `mcp` entrypoint is the MCP server over stdio, acting with one API key of one site. Create a key in the admin (`/admin/<slug>`, API keys), set it as `MYCEL_API_KEY` in `.env`, and let your MCP client start:

```sh
docker compose run --rm -T worker mcp
```

Stdio is the transport this release ships; the agent sees exactly the tools and capabilities of that key. Remote MCP over HTTP with its own authorization is planned (TODO #25).

## Upgrading

Pin `MYCEL_IMAGE` to the new release, check out the same release of this repository, then `docker compose pull && docker compose up -d`. `migrate` runs before the other services start; migrations only move forward. Which versions may be skipped and what a rollback can and cannot do: [upgrading.md](upgrading.md).

## Backups

Not part of this release yet: the backup image and its schedule come with TODO #18c. Until then, back up the `postgres` volume with `pg_dump` as the owner (`docker compose exec postgres pg_dump -U mycel -Fc mycel`) and your bucket with your provider's tools.

## Restore

Comes with the backup image (TODO #18c), as a procedure CI rehearses every month on an empty machine.

## Export

A per-site export and import with files comes with TODO #18d.
