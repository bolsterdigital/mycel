// The connection rules both adapters enforce (ADR 001, TODO #53 PR 3): who may read a credential,
// which credential a read serves, and that a disconnected connection is frozen. The memory adapter
// calls these per row; Postgres keeps its compare-and-swap in one statement, so it builds the
// WHERE from the same constant and checks the read with the same function.
// Rejected: a port method per rule (the adapters would still each decide what it means).

import type { Principal } from '../principal.js';
import type {
  ConnectionProvider,
  ConnectionRecord,
  ConnectionState,
  CredentialMode,
} from './ports.js';

/**
 * The one system job that may decrypt a connection credential through `ctx.connections`: the
 * connection worker. The other reader is the payment adapter, which the composition root hands
 * the active `mollie` connection's key directly (`PAYMENT_CONNECTION_PROVIDER`); no use case and
 * no principal ever sees that one.
 */
export const CREDENTIAL_READER_JOB = 'connections.run';

export const mayReadCredential = (principal: Principal): boolean =>
  principal.actor.kind === 'system' && principal.actor.job === CREDENTIAL_READER_JOB;

/** The connection whose credential the payment adapter uses (ADR 005 rule 3, ADR 024). */
export const PAYMENT_CONNECTION_PROVIDER = 'mollie' satisfies ConnectionProvider;

/** A Mollie API key: a test or live key. An OAuth access token is another kind of thing. */
export const MOLLIE_API_KEY = /^(test|live)_[A-Za-z0-9]{20,64}$/;

/**
 * Whether a stored key takes test or real payments, read from its prefix when it is written
 * (MY-262 PR 3). Not secret: the prefix is all it keeps. Null for a provider without modes.
 */
export const credentialModeOf = (
  provider: ConnectionProvider,
  secret: string
): CredentialMode | null =>
  provider === 'mollie' && MOLLIE_API_KEY.test(secret)
    ? secret.startsWith('live_')
      ? 'live'
      : 'test'
    : null;

/** A read serves the stored credential only for an active connection at the asked version. */
export const credentialServes = (
  row: Pick<ConnectionRecord, 'state' | 'credentialVersion'>,
  version: number
): boolean => row.state === 'active' && row.credentialVersion === version;

/** A disconnected connection is frozen: no config, state or credential write lands any more. */
export const FROZEN_CONNECTION_STATE = 'disconnected' satisfies ConnectionState;

export const isFrozen = (row: Pick<ConnectionRecord, 'state'>): boolean =>
  row.state === FROZEN_CONNECTION_STATE;

/** Whether a compare-and-swap write against `baseVersion` may change `row`. */
export const acceptsWrite = (
  row: Pick<ConnectionRecord, 'state' | 'version'>,
  baseVersion: number
): boolean => row.version === baseVersion && !isFrozen(row);

/** Moving to `state` deletes the stored credential when it freezes the connection. */
export const dropsCredential = (state: ConnectionState): boolean =>
  state === FROZEN_CONNECTION_STATE;
