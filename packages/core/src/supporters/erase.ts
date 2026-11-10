// The ordinary erasure request (ADR 019 rule 8 with ADR 032). `supporter.erase`
// registers one supporter by id and plans a `supporter.erase` job in the same transaction: the
// job exists if and only if the registration committed. The command never erases anything itself:
// a front runs as mycel_app, which may register but not enter `mycel_erasure`, so applying stays
// the worker's (packages/api/src/jobs.ts) and the CLI's. The address is read from the projection
// on the server and goes only into the register's hash; it is not in the input, the output, the
// audit row or the job payload.
//
// What the caller gets back is the state of the request, not a claim that the person is gone:
// `applied` says the worker has run the register over this supporter (the projection is a
// tombstone), `secured` that a backup holds the registration, so a restore of the last backup
// erases them again. Neither says anything about a provider that already received the address
// (ADR 032 rule 5); those copies are listed per connection, not here.
//
// Rejected: input by e-mail address (the address would sit in the audit hash input and every API
// log line; `supporter.get` finds the id), applying inside the request (the front would need the
// owner's connection, ADR 011), and a capability shared with `supporters:write` (an e-mail change
// is reversible, an erasure is not; ADR 018 rule 5 gives each irreversible effect its own).

import { z } from 'zod';
import { notFound, UseCaseError } from '../errors.js';
import { jobKey } from '../jobs/types.js';
import '../jobs/ports.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { exampleId } from '../util/ids.js';
import { isTombstone } from './erasure.js';
import './ports.js';

export const ErasureView = z.object({
  /** The supporter id; also the audit subject. */
  id: z.string().guid(),
  registeredAt: z.string().datetime(),
  /** The worker has applied the register to this supporter: the projection is a tombstone. */
  applied: z.boolean(),
  /** A backup holds the registration (`mycel erasures status`); until then a restore revives. */
  secured: z.boolean(),
});
export type ErasureView = z.infer<typeof ErasureView>;

async function erasureView(
  ctx: TransactionContext,
  supporterId: string
): Promise<ErasureView | null> {
  const registration = await ctx.erasures.get(supporterId);
  if (!registration) return null;
  const projection = await ctx.supporters.getProjectionById(supporterId);
  return {
    id: supporterId,
    registeredAt: registration.registeredAt.toISOString(),
    applied: projection !== null && isTombstone(projection.email),
    secured: registration.secured,
  };
}

export const eraseSupporter = defineUseCase({
  name: 'supporter.erase',
  kind: 'command',
  description:
    'Erase a supporter on request: registers the supporter id permanently and plans the background erasure of every copy (events, submissions, queued mail, archives). Returns the state of the request; it is complete once applied and secured by a backup. Works while the site is suspended. A later explicit signup of the same address starts a new supporter.',
  requires: 'supporters:erase',
  effect: 'erase',
  input: z.object({ supporterId: z.string().guid() }).strict(),
  output: ErasureView.extend({ created: z.boolean() }),
  examples: [{ input: { supporterId: exampleId(0x1) } }],
  async handler(ctx, { supporterId }) {
    const existing = await erasureView(ctx, supporterId);
    let created = false;
    if (!existing) {
      const before = await ctx.supporters.getProjectionById(supporterId);
      if (!before) throw notFound('supporter');
      // The read above was unlocked; under the address lock (the one ingest, admission and
      // apply take, ADR 032 rule 5) the supporter must still have that address.
      await ctx.supporters.lock(before.email);
      const current = await ctx.supporters.getProjectionById(supporterId);
      if (!current || current.email !== before.email)
        throw new UseCaseError('conflict', 'the supporter changed while the request ran; retry');
      // A concurrent request may have registered while this one waited for the lock.
      if (!(await ctx.erasures.get(supporterId))) {
        await ctx.erasures.register(supporterId, current.email);
        created = true;
      }
    }
    const view = (await erasureView(ctx, supporterId))!;
    if (!view.applied)
      await ctx.jobs.enqueue({
        type: 'supporter.erase',
        key: jobKey('supporter.erase', supporterId),
        runAt: ctx.clock.now(),
        payload: { supporterId },
      });
    return { ...view, created };
  },
});

export const getSupporterErasure = defineUseCase({
  name: 'supporter.erasure.get',
  kind: 'query',
  description:
    'Get the state of an erasure request by supporter id: when it was registered, whether the background erasure has run, and whether a backup holds the registration.',
  requires: 'supporters:read',
  input: z.object({ supporterId: z.string().guid() }).strict(),
  output: ErasureView,
  examples: [{ input: { supporterId: exampleId(0x1) } }],
  async handler(ctx, { supporterId }) {
    const view = await erasureView(ctx, supporterId);
    if (!view) throw notFound('erasure', 'that supporter');
    return view;
  },
});
