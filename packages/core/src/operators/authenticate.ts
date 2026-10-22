// How each front turns a credential into a Principal (ADR 002 rule 3), in one place so HTTP, MCP
// and the web admin cannot drift apart. Pure over the IdentityStore port: the adapters decide
// where identities live, this file decides what they grant.

import type { Principal } from '../principal.js';
import { hashApiKey } from './model.js';
import type { ApiKeyRecord, IdentityStore } from './ports.js';

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** The active key a token names, or null when it is unknown or revoked. */
export async function activeKey(
  identity: IdentityStore,
  token: string | undefined
): Promise<ApiKeyRecord | null> {
  if (!token) return null;
  const key = await identity.apiKeyByHash(await hashApiKey(token));
  return key && key.revokedAt === null ? key : null;
}

/** HTTP: `Authorization: Bearer <token>`. The capabilities are the key's own, nothing more. */
export async function apiKeyPrincipal(
  identity: IdentityStore,
  authorization: string | undefined
): Promise<{ principal: Principal; key: ApiKeyRecord } | null> {
  const key = await activeKey(identity, BEARER.exec(authorization ?? '')?.[1]);
  if (!key) return null;
  return {
    key,
    principal: {
      tenantId: key.tenantId,
      actor: { kind: 'api-key', keyId: key.id },
      capabilities: [...key.capabilities],
    },
  };
}

/** MCP: the same key, acting as one agent session. Looked up per call, so revocation is immediate. */
export async function agentPrincipalFor(
  identity: IdentityStore,
  token: string | undefined,
  sessionId: string
): Promise<{ principal: Principal; key: ApiKeyRecord } | null> {
  const key = await activeKey(identity, token);
  if (!key) return null;
  return {
    key,
    principal: {
      tenantId: key.tenantId,
      actor: { kind: 'agent', sessionId, keyId: key.id },
      capabilities: [...key.capabilities],
    },
  };
}

/**
 * Web admin: the operator's membership of the tenant in the URL, read on every request
 * (ADR 002 rule 3, ADR 014 rule 4). Null when they are not a member.
 */
export async function operatorPrincipal(
  identity: IdentityStore,
  operator: { operatorId: string; email: string },
  tenantId: string
): Promise<Principal | null> {
  const membership = (await identity.membershipsOf(operator.operatorId)).find(
    (m) => m.tenantId === tenantId
  );
  if (!membership) return null;
  // ADR 015, TODO #16: the tenant's entitlements join the Principal here.
  return {
    tenantId,
    actor: { kind: 'operator', operatorId: operator.operatorId, email: operator.email },
    capabilities: [...membership.capabilities],
  };
}
