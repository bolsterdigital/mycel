// Seed one sent newsletter edition (migration 0070), so the export conformance carries a
// `mail_editions` row through export and import and the RLS conformance has a row to hide.
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
}
