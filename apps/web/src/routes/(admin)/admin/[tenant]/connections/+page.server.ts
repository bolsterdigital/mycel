// Site operators manage the same registry operations exposed through HTTP and MCP. Every form
// posts without JavaScript; no credential or webhook payload is included in the page load.
import { can, useCases } from '@mycel/core';
import { error } from '@sveltejs/kit';
import { act, text } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'connections:read')) error(403, 'connections:read');
  const connections = (await runtime().invoker.run(useCases.listConnections, principal, {}))
    .connections;
  const intents = await Promise.all(
    connections.map(async (connection) => ({
      connectionId: connection.id,
      rows: (
        await runtime().invoker.run(useCases.listConnectionIntents, principal, {
          connectionId: connection.id,
        })
      ).intents,
    }))
  );
  return { connections, intents };
};

const copy = {
  conflict: 'admin.connections.error.conflict',
  invalid: 'admin.connections.error.invalid',
  notFound: 'admin.connections.error.notFound',
} as const;
const version = (data: FormData) => Number(text(data, 'version'));

export const actions: Actions = {
  create: (event) =>
    act(event, 'create', copy, async (principal, data) => {
      const connection = await runtime().invoker.run(useCases.createConnection, principal, {
        provider: 'webhook',
        accountRef: null,
        externalOwner: text(data, 'externalOwner'),
        maintainer: text(data, 'maintainer'),
        purpose: text(data, 'purpose'),
        direction: 'outbound',
        dataAuthority: 'mycel',
        consentAuthority: 'mycel',
        consentScopes: text(data, 'consentScopes')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        formIds: [],
        destination: text(data, 'destination'),
        contractVersion: 'v1',
        adapterVersion: 'v1',
      });
      return { action: 'create', done: 'admin.connections.done.created', id: connection.id };
    }),
  update: (event) =>
    act(event, 'update', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.updateConnection, principal, {
        id: text(data, 'id'),
        baseVersion: version(data),
        changes: {
          externalOwner: text(data, 'externalOwner'),
          maintainer: text(data, 'maintainer'),
          purpose: text(data, 'purpose'),
          destination: text(data, 'destination'),
          consentScopes: text(data, 'consentScopes')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      return { action: 'update', done: 'admin.connections.done.saved' };
    }),
  credential: (event) =>
    act(event, 'credential', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.replaceConnectionCredential, principal, {
        id: text(data, 'id'),
        baseVersion: version(data),
        secret: text(data, 'secret'),
      });
      return { action: 'credential', done: 'admin.connections.done.credential' };
    }),
  pause: (event) =>
    act(event, 'pause', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.pauseConnection, principal, {
        id: text(data, 'id'),
        baseVersion: version(data),
      });
      return { action: 'pause', done: 'admin.connections.done.paused' };
    }),
  resume: (event) =>
    act(event, 'resume', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.resumeConnection, principal, {
        id: text(data, 'id'),
        baseVersion: version(data),
      });
      return { action: 'resume', done: 'admin.connections.done.resumed' };
    }),
  disconnect: (event) =>
    act(event, 'disconnect', copy, async (principal, data) => {
      if (text(data, 'confirm') !== 'yes')
        return {
          action: 'disconnect',
          confirm: { id: text(data, 'id'), version: version(data) },
        };
      await runtime().invoker.run(useCases.disconnectConnection, principal, {
        id: text(data, 'id'),
        baseVersion: version(data),
      });
      return { action: 'disconnect', done: 'admin.connections.done.disconnected' };
    }),
  test: (event) =>
    act(event, 'test', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.testConnection, principal, { id: text(data, 'id') });
      return { action: 'test', done: 'admin.connections.done.test' };
    }),
  replay: (event) =>
    act(event, 'replay', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.replayConnectionIntent, principal, {
        id: text(data, 'id'),
      });
      return { action: 'replay', done: 'admin.connections.done.replay' };
    }),
  resolve: (event) =>
    act(event, 'resolve', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.resolveConnectionIntent, principal, {
        id: text(data, 'id'),
      });
      return { action: 'resolve', done: 'admin.connections.done.resolve' };
    }),
};
