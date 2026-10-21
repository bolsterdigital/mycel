# Contributing

Thanks for looking. This project is early; the most useful contributions right now are review of the [decisions](docs/adr/) and bug reports against them.

## Before you write code

1. Read `docs/adr/` (ten short files). A change that contradicts an accepted ADR needs a new ADR first.
2. Read [`docs/architecture/overview.md`](docs/architecture/overview.md) for where things go and which packages may import which.

## Setup

```sh
npm install
npm run verify
```

`verify` is the gate: formatting, dependency rules, types, tests, build. CI runs the same command. Keep it green on every commit.

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
