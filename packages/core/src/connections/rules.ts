// The connection rules both adapters enforce (ADR 001, TODO #53 PR 3): who may read a credential,
// which credential a read serves, and that a disconnected connection is frozen. The memory adapter
// calls these per row; Postgres keeps its compare-and-swap in one statement, so it builds the
// WHERE from the same constant and checks the read with the same function.
// Rejected: a port method per rule (the adapters would still each decide what it means).

import type { Principal } from '../principal.js';
import type { ConnectionRecord, ConnectionState } from './ports.js';

/** The one system job that may decrypt a connection credential: the connection worker. */
export const CREDENTIAL_READER_JOB = 'connections.run';

export const mayReadCredential = (principal: Principal): boolean =>
  principal.actor.kind === 'system' && principal.actor.job === CREDENTIAL_READER_JOB;

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
