# Upgrading Mycel

What a self-hoster can rely on when moving from one release to the next, and how this repository keeps that true. Installation itself: [self-hosting.md](self-hosting.md). What changed in each release: [CHANGELOG.md](../CHANGELOG.md).

## Releases

Every release is a tag `vX.Y.Z` on `main` and an image `ghcr.io/bolsterdigital/mycel:X.Y.Z` for `linux/amd64` and `linux/arm64`, with a build provenance attestation and a GitHub Release that carries its changelog section. The image is also tagged `X.Y`, `X` and `latest`; a prerelease (`X.Y.Z-rc.N`) gets only its own tag. Pin the full version in `MYCEL_IMAGE`: `latest` moves under you. `docker compose run --rm worker mycel version` prints the version a container runs, and `/metrics` carries it as `mycel_build_info{version="X.Y.Z"} 1`.

Check that an image was built from this repository by its release workflow:

```sh
gh attestation verify oci://ghcr.io/bolsterdigital/mycel:X.Y.Z --owner bolsterdigital
```

Versions follow semver. Before 1.0 a minor release may contain breaking changes; the changelog lists them first, under "Breaking changes", with what to do.

## The promise

1. **Upgrading is three steps.** Pin `MYCEL_IMAGE` to the new version and check out the same tag of this repository (compose mounts files from it), then `docker compose pull` and `docker compose up -d`. The `migrate` service runs to completion before `api`, `web` and `worker` start.
2. **Migrations only move forward and never change once applied.** There is no down migration; a mistake is corrected by the next migration. `migrate` records a sha256 of every file it applies and refuses to start when an applied file has changed since, before it applies or records anything.
3. **The previous minor keeps working on the new schema.** Within a major version no migration removes a column or table that the previous minor release still writes. Removing something takes two releases: release N stops writing it, release N+1 removes it, and the changelog of N announces that. So during a rolling restart, or after rolling the image back, the older image runs on the newer schema.
4. **Rolling back the image one version is safe; rolling back the schema does not exist.** Pin the previous `MYCEL_IMAGE` and `docker compose up -d`. Its `migrate` finds nothing to apply (the newer migrations stay) and the fronts run on the newer schema by promise 3. Going back further than one version, or past a major version, means restoring a backup.
5. **Versions may be skipped.** Upgrade from 0.1.0 straight to 0.4.0: `migrate` applies every migration in between, in order, in one run. Read the changelog sections you skip, for the breaking changes among them.

## How this repository keeps it

- `packages/db/src/infra/migrate.ts` stores the checksum in `schema_migrations.checksum` and refuses a changed applied file (`packages/db/src/infra/migrate.test.ts`). Rows applied before the checksum existed get the file's current checksum on the next run.
- The `verify` workflow fails a pull request that modifies, renames or deletes a file in `packages/db/migrations` that is already on `main`; only new files pass.
- Promise 3 is a review rule: a pull request that drops or renames a column or table says in its description which earlier release stopped writing it.
- The release workflow (`.github/workflows/release.yml`) only publishes a tag that is a commit on `main` and whose version equals the one in `package.json`.

## Cutting a release (maintainers)

On a clean, up-to-date `main`:

```sh
npm run release -- 0.2.0     # changelog section, versions in every package.json, signed-off commit, tag
git push --follow-tags       # the tag starts the release workflow
```

`npm run release -- unreleased` refreshes the `## Unreleased` preview in `CHANGELOG.md` without releasing. The changelog lines are the squash-merge titles of the pull requests since the previous tag, which is why every pull request title is a conventional commit ([CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests)).

After the very first push to GHCR the package is private, whatever the repository is. Make it public once: on GitHub, the organisation's **Packages** tab, package `mycel`, **Package settings**, **Change visibility** to public; under **Manage Actions access** the repository `bolsterdigital/mycel` keeps write access.
