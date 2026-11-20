// Seed one sent newsletter edition (migration 0070), a welcome series with one person in it
// (0082) and a launch step with a note (0085), so the export conformance carries
// `mail_editions`, `mail_automations` and their steps and `launch_steps` through export and import
// and the RLS conformance has a row to hide in each of those tables.
// Written through the repository, as `mailing.edition.send` writes it, against a real revision
// (the row's foreign key). Rejected: sending through the use case, which needs a published
// article and an e-mail renderer in suites that are about neither.
import { useCases, type Invoker, type Principal, type UnitOfWork } from '@mycel/core';
import { uuidv7 } from '../infra/ids.js';

export async function seedEdition(invoker: Invoker, uow: UnitOfWork, admin: Principal) {
  const { item, revision } = await invoker.run(useCases.createItem, admin, {
    slug: 'nieuwsbrief',
    document: {
      type: 'article',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: 'Nieuwsbrief' },
      blocks: [],
    },
  });
  await uow.run(admin, (ctx) =>
    ctx.mailEditions.insert({
      id: uuidv7(),
      itemId: item.id,
      list: 'newsletter',
      recipients: 1,
      sentAt: new Date(),
      locales: [
        {
          locale: 'nl',
          revisionId: revision.id,
          subject: 'Nieuwsbrief',
          html: '<p>Nieuwsbrief</p>',
          text: 'Nieuwsbrief',
        },
      ],
    })
  );
  // Through the repository too: the use case asks for a published item, which this article is not.
  const automationId = uuidv7();
  await uow.run(admin, async (ctx) => {
    await ctx.mailAutomations.save({
      id: automationId,
      list: 'newsletter',
      enabled: true,
      steps: [{ itemId: item.id, delayDays: 0 }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await ctx.mailAutomations.start(automationId, uuidv7(), new Date());
  });
  await invoker.run(useCases.updateLaunchStep, admin, {
    stepId: 'go-no-go',
    done: true,
    note: 'Approved',
  });
}
