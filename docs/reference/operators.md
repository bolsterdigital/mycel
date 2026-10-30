# Operators, keys and authentication

Who may act on a site and how a credential becomes a `Principal`. An operator is a person who logs in to the admin over OIDC; a membership gives them capabilities on one tenant; an API key belongs to one tenant and carries its own capabilities, for HTTP integrations and MCP agents. The tenant and capabilities always come from authentication, never from a payload (ADR 002 rule 3, [ADR 002](../adr/002-single-postgres-rls-tenancy.md)); authentication reads across tenants only through its own role ([ADR 011](../adr/011-background-roles-and-outbox.md)). Code: `packages/core/src/operators/`, `packages/db/src/operators.ts`, `apps/web/src/lib/server/admin/oidc.ts`. What each command leaves behind is in [audit.md](audit.md); the platform-level API is in [platform-api.md](platform-api.md).

## Principals

A `Principal` (`packages/core/src/principal.ts`) is a tenant id, an actor, a capability list and the tenant's effective entitlements and status ([ADR 015](../adr/015-entitlements-as-data.md)). The actor is one of:

| Kind        | Built by                                                | Carries                                    | Capabilities                                                     |
| ----------- | ------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `operator`  | `operatorPrincipal`, web admin                          | the stable operator id and e-mail address  | the membership of the tenant in the `/admin/{tenant}` URL        |
| `api-key`   | `apiKeyPrincipal`, HTTP `Authorization: Bearer <token>` | the key id                                 | the key's own                                                    |
| `agent`     | `agentPrincipalFor`, MCP                                | a session id (one per MCP process), key id | the key's own                                                    |
| `system`    | `systemPrincipal`, outbox subscribers, jobs, seed       | the job name                               | `tenant:admin`                                                   |
| `anonymous` | `anonymousPrincipal`, public pages                      | channel `web`, optional `ipHash`           | what the page needs: `content:read`, `forms:read`, `forms:write` |

The operator id is Mycel's own, never the IdP subject, so attribution survives a move between identity providers. Membership, key and tenant access are read on every request or tool call, never cached: a revoked key or removed membership stops working on the next request, also in an MCP process that is already running.

## Capabilities

`content:read`, `content:write`, `content:publish`, `forms:read`, `forms:write`, `supporters:read`, `supporters:write`, `supporters:export`, `donations:read`, `donations:write`, `mailing:read`, `mailing:send`, `money:refund`, `media:read`, `media:write`, `ai:assist`, `connections:read`, `connections:configure`, `connections:credentials`, `connections:replay`, `tenant:admin`.

`tenant:admin` implies every other capability (`can` and `grants`). Fine-grained rules live in the use cases. A key never carries `tenant:admin` (`KeyCapability`), so no integration or agent can manage members or keys. Capability lists are non-empty and without duplicates.

## Login and the session

Login is OIDC authorization code flow with PKCE (S256) through `openid-client`; `client_secret_post` when `OIDC_CLIENT_SECRET` is set, a public client otherwise. The flow's state, nonce, verifier and return path travel in a signed cookie `mycel_oidc` scoped to `/admin`. The callback checks state, nonce, PKCE and the ID token and refuses a token without an `email` claim; core only sees the claims (`LoginClaims`). Discovery runs once per process; plain `http` is accepted only for a local issuer and refused in production by the config.

`IdentityStore.login` identifies an operator by `(issuer, subject)`. A known pair updates address, name and last login and keeps `emailVerifiedAt` only while the address is unchanged and still verified. An unknown pair claims the pending invitation for its address only when the IdP says the address is verified; otherwise it becomes a new operator without memberships.

The session (`packages/core/src/operators/session.ts`) is a stateless value signed by the shared `Signer` in the cookie `mycel_session` (`Path=/admin`, `HttpOnly`, `SameSite=Lax`, `Secure` on https). It names the operator, a random session id and its issue and expiry times, nothing about tenants. It is absolute, never renewed: a new login is always a new value. `readSession` refuses a forged or malformed value, an expired one, one whose lifetime exceeds the maximum and one issued more than a minute in the future. There is no server-side session table, so there is no "log out everywhere".

Login starts and callbacks are rate limited together per client, keyed by `Signer.hashIp` of the client address (never the address), through `IdentityStore.loginAttempt`. The count is one upsert per `(key, window_start)` in `login_attempts` (migration 0018), so every web process shares the same fixed window. The hourly `rate_limits.sweep` job deletes windows older than a day as `mycel_janitor`.

For development and the end-to-end tests, `scripts/e2e/mock-oidc.mjs` is a minimal OpenID provider: discovery, a "sign in as" form that works without JavaScript (untick "verified" for an unverified address), a token endpoint that checks the PKCE verifier and a JWKS. The subject is derived from the address, so the same address is the same operator across restarts. It refuses to start with `NODE_ENV=production`.

## Database roles

| Role                  | What it does                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mycel_auth`          | nologin; entered with `set local role` per transaction by `createIdentityStore`. Reads memberships, keys and tenants of every tenant, writes `operators` and `login_attempts`                           |
| `mycel_authenticator` | the fronts' login (`AUTH_DATABASE_URL`); a member of `mycel_auth` without inherit, so it has no rights except entering that role. `migrate` gives it a password from `MYCEL_AUTH_PASSWORD`              |
| `mycel_app`           | runs the `tenant.member.*` and `tenant.key.*` use cases under RLS; sees operators only when they are members of its tenant (policy `member_read`) and reaches others only through `operator_for_invite` |

## Members and keys

Every use case below needs `tenant:admin`. Each write takes the tenant's membership lock first and reads the acting operator's membership again under it, so an admin who was just removed or demoted is refused (`stale_actor`) and two admins acting at once cannot both pass the "an admin remains" check. An API key or agent reaching these commands is refused.

| Use case               | Kind    | Effect                                                                                                                                            |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant.member.list`   | query   | the members with capabilities; `pending` while the operator has never logged in                                                                   |
| `tenant.member.invite` | command | gives an address capabilities; counts against `operators.max`; refused when the address is already a member or several verified accounts share it |
| `tenant.member.update` | command | replaces capabilities; revokes the keys that operator made which now exceed them; refused if it would leave no `tenant:admin`                     |
| `tenant.member.remove` | command | removes the membership and revokes every key that operator made; same last-admin rule                                                             |
| `tenant.key.list`      | query   | every key, revoked ones included; prefix, never hash or token                                                                                     |
| `tenant.key.create`    | command | needs the `api_keys` entitlement; a key gets only capabilities the creator holds now; the token is returned once                                  |
| `tenant.key.revoke`    | command | sets `revoked_at`; the key stays listed                                                                                                           |

An invitation is a membership of a pending operator row (no subject yet); it does not expire and gives access once someone logs in with that address verified. Keys made by `system` (the seed) are never revoked by a membership change. A token is `mycel_` plus 32 random bytes in base64url; only its SHA-256 is stored, and the first characters are kept as the display prefix. `last_used_at` is updated after the request, in its own transaction, at most once a minute per key.

## Constants

| Constant               | Value                                         | Where                                          | Why                                                             |
| ---------------------- | --------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `SESSION_TTL_MS`       | 12 hours                                      | `packages/core/src/operators/session.ts`       | absolute lifetime; a stolen cookie stops on a fixed clock       |
| future `iat` allowance | 60 s                                          | `packages/core/src/operators/session.ts`       | clock skew between processes; a session issued later is refused |
| `OIDC_COOKIE_TTL_MS`   | 10 minutes                                    | `apps/web/src/lib/server/admin/oidc.ts`        | one login attempt at the IdP                                    |
| `LOGIN_LIMIT`          | 20 per 10 minutes                             | `apps/web/src/lib/server/admin/admin-paths.ts` | login starts and callbacks per client address hash              |
| `KEEP`                 | 1 day                                         | `packages/db/src/infra/janitor.ts`             | age after which login and rate-limit windows are swept          |
| token                  | `mycel_` + 32 bytes (43 base64url characters) | `packages/core/src/operators/model.ts`         | 256 bits make a plain SHA-256 an unguessable lookup key         |
| `PREFIX_LENGTH`        | 12                                            | `packages/core/src/operators/model.ts`         | enough of the token to recognise a key in a list                |
| key touch resolution   | 1 minute                                      | `packages/db/src/operators.ts`                 | a busy key does not write on every request                      |
| key name               | 1 to 100 characters                           | `packages/core/src/operators/service.ts`       | input bound                                                     |
| `operators.max`        | 50 (default)                                  | `packages/core/src/entitlements/model.ts`      | members per tenant, checked on invite under the membership lock |
