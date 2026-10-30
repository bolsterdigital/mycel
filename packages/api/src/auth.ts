// API keys as the HTTP and MCP fronts use them (TODO #7, brief decision 5). The principal comes
// from the `api_keys` row on every request or tool call, never from a cache, so revoking a key
// takes effect on the next request and in an MCP process that is already running. Afterwards
// `last_used_at` is updated in a transaction of its own, outside the use case and without the
// request waiting for it: a failed touch is logged, never a failed request.
//
// Separate from compose.ts so the fronts' tests can run it over in-memory ports.

import {
  UseCaseError,
  agentPrincipalFor,
  apiKeyPrincipal,
  errorFields,
  noopLogger,
  type ApiKeyRecord,
  type Clock,
  type IdentityStore,
  type Logger,
  type Principal,
  type UnitOfWork,
} from '@mycel/core';

export interface AuthenticatorDeps {
  identity: IdentityStore;
  uow: UnitOfWork;
  clock: Clock;
  /** The token an MCP process acts with (MYCEL_API_KEY). */
  agentToken?: string | undefined;
  /** One per process: every tool call of this MCP server is one agent session. */
  sessionId: string;
  log?: Logger;
}

export interface Authenticator {
  /** Principal for `Authorization: Bearer <token>`, or null when unknown or revoked. */
  authenticateApiKey(authorization: string | undefined): Promise<Principal | null>;
  /** Principal for an MCP session; a UseCaseError when the key is missing, unknown or revoked. */
  agentPrincipal(): Promise<Principal>;
}

export function createAuthenticator({
  identity,
  uow,
  clock,
  agentToken,
  sessionId,
  log = noopLogger,
}: AuthenticatorDeps): Authenticator {
  const touch = (principal: Principal, key: ApiKeyRecord) => {
    void uow
      .run(principal, (ctx) => ctx.apiKeys.touch(key.id, clock.now()))
      .catch((e) =>
        log.error('api key: last_used_at not updated', { key: key.id, ...errorFields(e) })
      );
  };
  return {
    async authenticateApiKey(authorization) {
      const found = await apiKeyPrincipal(identity, authorization);
      if (!found) return null;
      touch(found.principal, found.key);
      return found.principal;
    },
    async agentPrincipal() {
      if (!agentToken)
        throw new UseCaseError('forbidden', 'MYCEL_API_KEY is not set for this MCP server');
      const found = await agentPrincipalFor(identity, agentToken, sessionId);
      if (!found) throw new UseCaseError('forbidden', 'MYCEL_API_KEY is unknown or revoked');
      touch(found.principal, found.key);
      return found.principal;
    },
  };
}
