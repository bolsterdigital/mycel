// A connection is tenant-owned configuration. The adapter stores credentials separately and
// encrypted, so neither a read nor an export can accidentally return their plaintext.

export type ConnectionProvider = 'webhook' | 'mailchimp';
export type ConnectionState = 'active' | 'paused' | 'disconnected';
export type ConnectionDirection = 'outbound' | 'inbound' | 'bidirectional';
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

declare module '../ports.js' {
  interface TransactionContext {
    connections: ConnectionRepository;
  }
}
