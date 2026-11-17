// The supporter of the RLS fixture (../rls.conformance.test.ts): a signup through the form, its
// ingest into the log and the projection, and a reader sign-in of that supporter (0069: a pending
// link and a session). One subject in a file of its own, so the conformance file holds the checks
// and not every row's setup. Returns the address and the signup's event, which the caller hands
// to further subscribers.
// Rejected: seeding the reader rows through `reader.signin.request` and `complete` (they need a
// timing token and a signer agreement the catalog-wide check has no use for; readers.test.ts
// proves the flow).

import {
  supporterIngestSubscriber,
  useCases,
  type Invoker,
  type Principal,
  type UnitOfWork,
} from '@mycel/core';
import { uuidv7 } from '../infra/ids.js';

export async function seedSupporter(
  invoker: Invoker,
  uow: UnitOfWork,
  admin: Principal,
  { formId, run }: { formId: string; run: string }
) {
  const email = `rls-${run}@example.org`;
  const submitted = await invoker.run(useCases.submitForm, admin, {
    formId,
    values: { email, consent: true },
    locale: 'nl',
  });
  if (submitted.status !== 'accepted') throw new Error(`fixture signup ${submitted.status}`);
  const event = {
    id: uuidv7(),
    type: 'newsletter.subscribed',
    tenantId: admin.tenantId,
    occurredAt: new Date(),
    actor: { kind: 'system' as const, job: 'rls-test' },
    props: {
      email,
      list: 'newsletter',
      formId,
      submissionId: submitted.submissionId,
      locale: 'nl',
      pageUrl: null,
      consentTextVersion: 'v1',
      confirmed: false,
    },
  };
  await supporterIngestSubscriber(uow).handle(event);
  await uow.run(admin, async (ctx) => {
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 15 * 60 * 1000);
    await ctx.signinLinks.insert({
      id: uuidv7(),
      email,
      tokenHash: '0'.repeat(64),
      locale: 'nl',
      returnPath: null,
      createdAt,
      expiresAt,
      consumedAt: null,
    });
    const reader = await ctx.supporters.getProjection(email);
    if (!reader) throw new Error('fixture supporter was not ingested');
    await ctx.readerSessions.insert({
      id: uuidv7(),
      supporterId: reader.id,
      createdAt,
      expiresAt,
      revokedAt: null,
    });
  });
  return { email, event };
}
