// Managed connection metadata and credentials are separate capabilities. Rejected: exposing
// secrets through a general tenant settings document or accepting tenant ids from input.

import { z } from 'zod';
import { UseCaseError } from '../errors.js';
import { checkDestination } from './destination.js';
import { defineUseCase } from '../registry.js';
import type { TransactionContext } from '../ports.js';
import { CONNECTION_DIRECTIONS, CONNECTION_PROVIDERS, type ConnectionRecord } from './ports.js';
import { isFrozen } from './rules.js';

const uuid = z.string().guid();
const exampleId = '01900000-0000-7000-8000-000000000001';
const shortText = z.string().trim().min(1).max(160);
const versionText = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const scopes = z.array(z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/)).max(30);
const formIds = z.array(uuid).max(100);
const destination = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  })
  .nullable();
const provider = z.enum(CONNECTION_PROVIDERS);
const direction = z.enum(CONNECTION_DIRECTIONS);
const authority = z.enum(['mycel', 'external']);
const state = z.enum(['active', 'paused', 'disconnected']);
const fields = {
  accountRef: shortText.nullable(),
  externalOwner: shortText,
  maintainer: shortText,
  purpose: shortText,
  direction,
  dataAuthority: authority,
  consentAuthority: authority,
  consentScopes: scopes,
  formIds,
  destination,
  contractVersion: versionText,
  adapterVersion: versionText,
};
const view = z.object({
  id: uuid,
  provider,
  ...fields,
  state,
  version: z.number().int().positive(),
  credentialVersion: z.number().int().nonnegative(),
  credentialStatus: z.enum(['connected', 'reconnect-required']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const idInput = z.object({ id: uuid }).strict();
const versionInput = z.object({ id: uuid, baseVersion: z.number().int().positive() }).strict();
const exampleFields = {
  accountRef: null,
  externalOwner: 'Example organisation',
  maintainer: 'Example maintainer',
  purpose: 'Newsletter delivery',
  direction: 'outbound' as const,
  dataAuthority: 'mycel' as const,
  consentAuthority: 'mycel' as const,
  consentScopes: ['newsletter:main'],
  formIds: [],
  destination: 'https://hooks.example.org/mycel',
  contractVersion: 'v1',
  adapterVersion: 'v1',
};
const asView = (record: ConnectionRecord) => ({
  ...record,
  credentialStatus: record.hasCredential ? ('connected' as const) : ('reconnect-required' as const),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});
const find = async (ctx: TransactionContext, id: string) => {
  const record = await ctx.connections.get(id);
  if (!record) throw new UseCaseError('not_found', 'connection not found');
  return record;
};
/** No use case changes a disconnected connection; the adapters refuse the write as well. */
const refuseFrozen = (prior: ConnectionRecord) => {
  if (isFrozen(prior)) throw new UseCaseError('conflict', 'connection disconnected');
};
const changed = (record: ConnectionRecord | null) => {
  if (!record) throw new UseCaseError('conflict', 'connection changed or not found');
  return asView(record);
};

export const listConnections = defineUseCase({
  name: 'connection.list',
  kind: 'query',
  description: 'List this site’s managed external connections without credentials.',
  requires: 'connections:read',
  authenticatedOnly: true,
  input: z.object({}).strict(),
  output: z.object({ connections: z.array(view) }),
  examples: [{ input: {} }],
  async handler(ctx) {
    return { connections: (await ctx.connections.list()).map(asView) };
  },
});

export const getConnection = defineUseCase({
  name: 'connection.get',
  kind: 'query',
  description: 'Read one managed connection of this site without its credential.',
  requires: 'connections:read',
  authenticatedOnly: true,
  input: idInput,
  output: view,
  examples: [{ input: { id: exampleId } }],
  async handler(ctx, { id }) {
    return asView(await find(ctx, id));
  },
});

export const createConnection = defineUseCase({
  name: 'connection.create',
  kind: 'command',
  description: 'Register an external connection with an explicit owner and data authority.',
  requires: 'connections:configure',
  authenticatedOnly: true,
  consumes: null,
  input: z.object({ provider, ...fields }).strict(),
  output: view,
  examples: [{ input: { provider: 'webhook', ...exampleFields } }],
  async handler(ctx, input) {
    if (input.provider === 'webhook' && input.destination === null)
      throw new UseCaseError('invalid_input', 'webhook destination required');
    if (input.destination !== null) await checkDestination(ctx.dns, input.destination);
    return asView(await ctx.connections.insert({ id: ctx.ids.next(), ...input }, ctx.clock.now()));
  },
});

export const updateConnection = defineUseCase({
  name: 'connection.update',
  kind: 'command',
  description: 'Change a managed connection using its current version.',
  requires: 'connections:configure',
  authenticatedOnly: true,
  input: z
    .object({
      id: uuid,
      baseVersion: z.number().int().positive(),
      changes: z.object(fields).partial().strict(),
    })
    .strict(),
  output: view,
  examples: [{ input: { id: exampleId, baseVersion: 1, changes: { purpose: 'Updated purpose' } } }],
  async handler(ctx, { id, baseVersion, changes }) {
    const prior = await find(ctx, id);
    refuseFrozen(prior);
    const nextDestination =
      changes.destination === undefined ? prior.destination : changes.destination;
    if (prior.provider === 'webhook' && nextDestination === null)
      throw new UseCaseError('invalid_input', 'webhook destination required');
    if (changes.destination) await checkDestination(ctx.dns, changes.destination);
    return changed(await ctx.connections.update(id, baseVersion, changes, ctx.clock.now()));
  },
});

function stateChange(
  name: string,
  next: 'paused' | 'active' | 'disconnected',
  description: string
) {
  return defineUseCase({
    name,
    kind: 'command',
    description,
    requires: 'connections:configure',
    authenticatedOnly: true,
    input: versionInput,
    output: view,
    examples: [{ input: { id: exampleId, baseVersion: 1 } }],
    async handler(ctx, { id, baseVersion }) {
      const prior = await find(ctx, id);
      refuseFrozen(prior);
      if (next === 'active' && !prior.hasCredential)
        throw new UseCaseError('conflict', 'connection needs a credential');
      return changed(await ctx.connections.state(id, baseVersion, next, ctx.clock.now()));
    },
  });
}

export const pauseConnection = stateChange(
  'connection.pause',
  'paused',
  'Stop new and pending work for this connection.'
);
export const resumeConnection = stateChange(
  'connection.resume',
  'active',
  'Allow this credentialed connection to be used again.'
);
export const disconnectConnection = stateChange(
  'connection.disconnect',
  'disconnected',
  'Permanently disconnect this connection and stop its work.'
);

export const replaceConnectionCredential = defineUseCase({
  name: 'connection.credential.update',
  kind: 'command',
  description: 'Replace a connection credential without exposing it in any read result.',
  requires: 'connections:credentials',
  authenticatedOnly: true,
  input: z
    .object({
      id: uuid,
      baseVersion: z.number().int().positive(),
      secret: z.string().min(1).max(8192),
    })
    .strict(),
  output: view,
  examples: [{ input: { id: exampleId, baseVersion: 1, secret: 'example-only' } }],
  async handler(ctx, { id, baseVersion, secret }) {
    const prior = await find(ctx, id);
    refuseFrozen(prior);
    return changed(
      await ctx.connections.replaceCredential(id, baseVersion, secret, ctx.clock.now())
    );
  },
});
