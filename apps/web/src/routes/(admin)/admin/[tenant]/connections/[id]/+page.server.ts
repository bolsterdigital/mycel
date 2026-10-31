// One connection (brief admin-operations-screens § 8, #82 PR 3): its stand, the kill-switch
// (pause and resume), a synthetic test, the latest delivery attempts with the reconciliation an
// operator may do next (replay or close by hand, as `operatorAction` says), the details, the
// signing secret and disconnecting. Every form posts without JavaScript to the registry
// operations HTTP and MCP expose; connection actions act on the id in the path, attempt actions
// on the attempt they name. The secret is write-only: the page shows only whether one is set.
// Rejected: reading the connection with `connection.get` (an unknown id would surface as a
// server error; the list is small and already authorised) and a confirm dialog in JavaScript
// for disconnecting (a second post with `confirm=yes` works without it).
import { useCases } from '@mycel/core';
import { error } from '@sveltejs/kit';
import { act, loaded, text } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import { ui } from '../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params }) => {
  const { locale } = await parent();
  const t = ui(locale);
  const principal = locals.principal!;
  const run = runtime().invoker;
  const { connections } = await loaded(run.run(useCases.listConnections, principal, {}));
  const connection = connections.find((c) => c.id === params.id);
  if (!connection) error(404, t('admin.connections.error.notFound'));
  const { intents } = await loaded(
    run.run(useCases.listConnectionIntents, principal, { connectionId: connection.id })
  );
  /** One moment for every relative time on the page, the same on server and client. */
  return { connection, intents, now: new Date().toISOString() };
};

const copy = {
  conflict: 'admin.connections.error.conflict',
  invalid: 'admin.connections.error.invalid',
  notFound: 'admin.connections.error.notFound',
} as const;
const version = (data: FormData) => Number(text(data, 'version'));

export const actions: Actions = {
  update: (event) =>
    act(event, 'update', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.updateConnection, principal, {
        id: event.params.id,
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
        id: event.params.id,
        baseVersion: version(data),
        secret: text(data, 'secret'),
      });
      return { action: 'credential', done: 'admin.connections.done.credential' };
    }),
  pause: (event) =>
    act(event, 'pause', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.pauseConnection, principal, {
        id: event.params.id,
        baseVersion: version(data),
      });
      return { action: 'pause', done: 'admin.connections.done.paused' };
    }),
  resume: (event) =>
    act(event, 'resume', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.resumeConnection, principal, {
        id: event.params.id,
        baseVersion: version(data),
      });
      return { action: 'resume', done: 'admin.connections.done.resumed' };
    }),
  disconnect: (event) =>
    act(event, 'disconnect', copy, async (principal, data) => {
      if (text(data, 'confirm') !== 'yes')
        return {
          action: 'disconnect',
          confirm: { version: version(data) },
        };
      await runtime().invoker.run(useCases.disconnectConnection, principal, {
        id: event.params.id,
        baseVersion: version(data),
      });
      return { action: 'disconnect', done: 'admin.connections.done.disconnected' };
    }),
  test: (event) =>
    act(event, 'test', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.testConnection, principal, { id: event.params.id });
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
