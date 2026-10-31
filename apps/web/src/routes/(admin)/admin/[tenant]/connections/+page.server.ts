// The connections of a site as a list (brief admin-operations-screens § 8, #82 PR 3): every
// connection with its stand and last activity, read from the same registry operations HTTP and
// MCP expose; adding one is the only action here, the rest lives on its own page
// (connections/[id]). No credential or webhook payload is included in the page load.
// Rejected: a card per connection with every form in it (up to six forms per card buried the
// stand) and a separate count query (the latest attempts are already read per connection).
import { can, useCases } from '@mycel/core';
import { error, redirect } from '@sveltejs/kit';
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
  /** One moment for every relative time on the page, the same on server and client. */
  return { connections, intents, now: new Date().toISOString() };
};

const copy = {
  conflict: 'admin.connections.error.conflict',
  invalid: 'admin.connections.error.invalid',
  notFound: 'admin.connections.error.notFound',
} as const;

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
      redirect(303, `/admin/${event.params.tenant}/connections/${connection.id}?created=1`);
    }),
};
