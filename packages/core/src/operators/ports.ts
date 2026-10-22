// Two kinds of port. `IdentityStore` answers the questions authentication asks before a tenant
// context exists (who is this operator, which tenants may they enter, which key is this); its
// adapter reads across tenants through the dedicated `mycel_auth` role (ADR 011 rule 1). The
// repositories run inside a use case's tenant transaction like any other and see one tenant only.

import type { TenantAccess } from '../entitlements/model.js';
import type { Capability } from '../principal.js';
import type { ApiKeySummary, KeyCapability, Member, Operator } from './model.js';

/** Claims the web front takes from a validated ID token. Core never sees OIDC itself. */
export interface LoginClaims {
  issuer: string;
  subject: string;
  /** Normalised by the store. */
  email: string;
  emailVerified: boolean;
  name?: string | null;
}

export interface OperatorMembership {
  tenantId: string;
  slug: string;
  name: string;
  capabilities: Capability[];
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  capabilities: KeyCapability[];
  revokedAt: Date | null;
}

export interface IdentityStore {
  /**
   * Record a login and return the operator. `(issuer, subject)` is the identity: a known pair
   * updates address, name and last login, and keeps `emailVerifiedAt` only while the address is
   * unchanged and still verified. An unknown pair claims the pending invitation for its address
   * only when the IdP vouches for the address (`emailVerified`); otherwise it becomes a new
   * operator without memberships.
   */
  login(claims: LoginClaims): Promise<Operator>;
  membershipsOf(operatorId: string): Promise<OperatorMembership[]>;
  /** Revoked keys are returned too, with `revokedAt` set; the caller refuses them. */
  apiKeyByHash(hash: string): Promise<ApiKeyRecord | null>;
  /**
   * The tenant's effective entitlements (the stored document merged over the defaults) and its
   * status, for the Principal (ADR 015 rule 3). Defaults and `active` for an unknown tenant: the
   * credential that named it is checked by the caller.
   */
  tenantAccess(tenantId: string): Promise<TenantAccess>;
}

export interface OperatorRepository {
  /**
   * The operator an invitation for `email` goes to: the pending row for the address, else the one
   * operator who logged in with that address verified, else a new pending row with `newId`.
   * `ambiguous` when several verified operators share the address. Reveals nothing else about
   * operators outside this tenant.
   */
  forInvite(email: string, newId: string): Promise<{ id: string } | 'ambiguous'>;
}

export interface MembershipRepository {
  /** Serialise membership changes of this tenant until the transaction ends. */
  lock(): Promise<void>;
  list(): Promise<Member[]>;
  get(operatorId: string): Promise<Member | null>;
  findByEmail(email: string): Promise<Member | null>;
  insert(operatorId: string, capabilities: Capability[], at: Date): Promise<void>;
  update(operatorId: string, capabilities: Capability[]): Promise<boolean>;
  remove(operatorId: string): Promise<boolean>;
}

export interface NewApiKey {
  id: string;
  name: string;
  prefix: string;
  keyHash: string;
  capabilities: KeyCapability[];
  createdBy: ApiKeySummary['createdBy'];
  createdAt: Date;
}

export interface ApiKeyRepository {
  list(): Promise<ApiKeySummary[]>;
  insert(key: NewApiKey): Promise<void>;
  /** False when there is no such key or it was already revoked. */
  revoke(id: string, at: Date): Promise<boolean>;
  /** Unrevoked keys an operator created, for the membership rules in the service. */
  createdBy(operatorId: string): Promise<ApiKeySummary[]>;
  /** Minute resolution: a busy key does not write on every request. */
  touch(id: string, at: Date): Promise<void>;
}

declare module '../ports.js' {
  interface TransactionContext {
    operators: OperatorRepository;
    members: MembershipRepository;
    apiKeys: ApiKeyRepository;
  }
}
