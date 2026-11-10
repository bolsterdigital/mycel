// A connection is tenant-owned configuration. The adapter stores credentials separately and
// encrypted, so neither a read nor an export can accidentally return their plaintext.

import type { TransactionContext } from '../ports.js';
import type { ConnectionAttempt, ConnectionFailure, ConnectionIntent } from './intents.js';

export const CONNECTION_PROVIDERS = ['webhook', 'mailchimp'] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];
export type ConnectionState = 'active' | 'paused' | 'disconnected';
export const CONNECTION_DIRECTIONS = ['outbound'] as const;
export type ConnectionDirection = (typeof CONNECTION_DIRECTIONS)[number];

/**
 * Whether a provider's transport can prove, after an ambiguous attempt, that the effect did or did
 * not happen. Only then may an operator ask for a replay of an `unknown` intent; otherwise the
 * intent is resolved by hand. A webhook receiver gives no such proof.
 */
export const PROVIDER_RECONCILES: Readonly<Record<ConnectionProvider, boolean>> = {
  webhook: false,
  mailchimp: true,
};
export type ConnectionAuthority = 'mycel' | 'external';

export interface ConnectionRecord {
  id: string;
  provider: ConnectionProvider;
  accountRef: string | null;
  externalOwner: string;
  maintainer: string;
  purpose: string;
  direction: ConnectionDirection;
  dataAuthority: ConnectionAuthority;
  consentAuthority: ConnectionAuthority;
  consentScopes: string[];
  formIds: string[];
  destination: string | null;
  contractVersion: string;
  adapterVersion: string;
  state: ConnectionState;
  version: number;
  credentialVersion: number;
  hasCredential: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type NewConnection = Omit<
  ConnectionRecord,
  'state' | 'version' | 'credentialVersion' | 'hasCredential' | 'createdAt' | 'updatedAt'
>;

type ChangeFields = Pick<
  ConnectionRecord,
  | 'accountRef'
  | 'externalOwner'
  | 'maintainer'
  | 'purpose'
  | 'direction'
  | 'dataAuthority'
  | 'consentAuthority'
  | 'consentScopes'
  | 'formIds'
  | 'destination'
  | 'contractVersion'
  | 'adapterVersion'
>;
export type ConnectionChanges = { [K in keyof ChangeFields]?: ChangeFields[K] | undefined };

export interface ConnectionRepository {
  get(id: string): Promise<ConnectionRecord | null>;
  list(): Promise<ConnectionRecord[]>;
  /** Worker-only read. Never expose this value through a use case or audit record. */
  credential(id: string, version: number): Promise<string | null>;
  insert(record: NewConnection, at: Date): Promise<ConnectionRecord>;
  /** Compare-and-swap makes stale config and credential writes fail closed. */
  update(
    id: string,
    baseVersion: number,
    changes: ConnectionChanges,
    at: Date
  ): Promise<ConnectionRecord | null>;
  state(
    id: string,
    baseVersion: number,
    next: ConnectionState,
    at: Date
  ): Promise<ConnectionRecord | null>;
  /** Plaintext crosses only this write boundary and is never returned. */
  replaceCredential(
    id: string,
    baseVersion: number,
    secret: string,
    at: Date
  ): Promise<ConnectionRecord | null>;
}

export interface ConnectionIntents {
  get(id: string): Promise<ConnectionIntent | null>;
  list(connectionId: string, limit: number): Promise<ConnectionIntent[]>;
  /** The newest `limit` intents of every connection of this tenant, in one read. */
  recent(limit: number): Promise<ConnectionIntent[]>;
  byBusiness(connectionId: string, businessId: string): Promise<ConnectionIntent | null>;
  insert(row: ConnectionIntent): Promise<boolean>;
  /** Atomically replace only the revision read; every successful replacement increments it. */
  replace(row: ConnectionIntent, expectedRevision: number): Promise<boolean>;
  record(attempt: ConnectionAttempt): Promise<void>;
  attempts(id: string): Promise<ConnectionAttempt[]>;
  /** Register, not just the asynchronously scrubbed projection. */
  erased(supporterId: string): Promise<boolean>;
}

declare module '../ports.js' {
  interface TransactionContext {
    connections: ConnectionRepository;
    connectionIntents: ConnectionIntents;
  }
}

/** Installed sources resolve a pinned mapping and current external suppression, in tenant context.
 * Sources are installed explicitly. A source must not infer permission from a prior payload.
 * `ready` means this exact mapping, operation and consent scope are currently authorized.
 */
export interface ConnectionSource {
  /** Additional source authority, rechecked after preparation with refreshed tenant access.
   * Absent means the generic connection authority suffices for this source.
   */
  authorize?(
    ctx: TransactionContext,
    intent: Readonly<ConnectionIntent>
  ): Promise<ConnectionFailure | null>;
  prepare(
    ctx: TransactionContext,
    intent: Readonly<ConnectionIntent>
  ): Promise<
    | { ready: true; payload: Readonly<Record<string, unknown>> }
    | { ready: false; failure: ConnectionFailure }
  >;
}
export interface ConnectionTransport {
  /** `succeeded` proves the business effect, not merely an HTTP 2xx. Throws mean unknown. */
  dispatch(input: {
    tenantId: string;
    intent: Readonly<ConnectionIntent>;
    connection: Readonly<ConnectionRecord>;
    credential: string;
    payload: Readonly<Record<string, unknown>>;
  }): Promise<'succeeded' | 'pre_send' | 'unknown'>;
  /**
   * `absent` must prove no previous or still-running call can later perform the effect. A
   * transport without this proof omits it: its unknown intents wait for manual resolution and
   * are never attempted again (`PROVIDER_RECONCILES` says the same to the use cases).
   */
  reconcile?(input: {
    tenantId: string;
    intent: Readonly<ConnectionIntent>;
    connection: Readonly<ConnectionRecord>;
    credential: string;
    payload: Readonly<Record<string, unknown>>;
  }): Promise<'succeeded' | 'absent' | 'unknown'>;
}

declare module '../ports.js' {
  interface TransactionContext {
    mailchimpReceipts: import('./mailchimp/ports.js').MailchimpReceipts;
    mailchimpDiscovery: import('./mailchimp/ports.js').MailchimpDiscovery;
  }
}
