// Every block type's registry example as mail, in nl and en: the core suite checks
// that each type becomes something, the renderer suite snapshots what. One builder, so a new block
// type lands in both by adding its example. The example image and linked item are made for real
// (an uploaded PNG, a published public article), so resolution runs as it does on a site.
// Rejected: hand-written `EmailDocument` fixtures, which would test the renderer against a model
// the core never produces.

import { BLOCK_DEFINITIONS, BLOCK_TYPES, EXAMPLE_IDS, type BlockType } from '../content/blocks.js';
import { ContentDocument } from '../content/model.js';
import { Invoker } from '../invoke.js';
import { emailDocument, type EmailDocument, type EmailSite } from '../mailing/email.js';
import { EXAMPLE_PNG } from '../media/service.js';
import { systemPrincipal } from '../principal.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { TENANT } from './fixtures.js';
import { MemoryUnitOfWork } from './memory.js';

export const EMAIL_SITE: EmailSite = {
  name: 'Vogelwijk Energie',
  url: 'https://vogelwijk.example.org',
  defaultLocale: 'nl',
};

export interface EmailExample {
  type: BlockType;
  locale: 'nl' | 'en';
  email: EmailDocument;
}

/** The first example of every block type as one mail per locale, plus the document header. */
export async function emailExamples(): Promise<{
  examples: EmailExample[];
  header: Record<'nl' | 'en', EmailDocument>;
  imageId: string;
  linkedItemId: string;
}> {
  const uow = new MemoryUnitOfWork();
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(TENANT, 'email-examples');
  const upload = await invoker.run(useCases.uploadMedia, admin, {
    filename: 'malieveld.png',
    contentType: 'image/png',
    bytes: EXAMPLE_PNG,
    caption: { nl: 'Het Malieveld op zaterdag', en: 'The Malieveld on Saturday' },
    credit: { work: null, photographer: 'Noor Bakker' },
  });
  const imageId = upload.id;
  const linked = await invoker.run(useCases.createItem, admin, {
    slug: 'rapport',
    document: { ...articleBase('Het rapport', 'The report'), blocks: [] },
  });
  const linkedItemId = linked.item.id;
  for (const locale of ['nl', 'en'])
    await invoker.run(useCases.publishItem, admin, {
      itemId: linkedItemId,
      revisionId: linked.revision.id,
      locale,
    });

  // The examples' synthetic ids become the real image and item; other references stay unresolved.
  const real = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll(EXAMPLE_IDS.image, imageId)
        .replaceAll(EXAMPLE_IDS.portrait, imageId)
        .replaceAll(EXAMPLE_IDS.item, linkedItemId)
    ) as unknown;
  const item = { id: exampleItemId, type: 'article' as const, slug: 'buurtbatterij' };
  const mail = (doc: ContentDocument, locale: 'nl' | 'en') =>
    uow.run(admin, (ctx) => emailDocument(ctx, { item, doc, locale, site: EMAIL_SITE }));

  const examples: EmailExample[] = [];
  for (const type of BLOCK_TYPES) {
    const example = BLOCK_DEFINITIONS[type].examples[0]!;
    const doc = ContentDocument.parse({
      ...articleBase('Een buurtbatterij', 'A neighbourhood battery'),
      blocks: [
        {
          id: `${type}-0`,
          type,
          version: BLOCK_DEFINITIONS[type].version,
          props: real(example.props),
        },
      ],
      // A paywall is only valid as the marker teaser of a restricted item.
      ...(type === 'paywall' ? { access: { level: 'members', teaser: 'marker' } } : {}),
    });
    for (const locale of ['nl', 'en'] as const)
      examples.push({ type, locale, email: await mail(doc, locale) });
  }

  const headerDoc = ContentDocument.parse({
    ...articleBase('Een buurtbatterij voor de Vogelwijk', 'A battery for the Vogelwijk'),
    lead: {
      nl: 'Vanaf het voorjaar slaat een gedeelde batterij de zonnestroom van veertig daken op.',
      en: 'From spring, a shared battery stores the solar power of forty roofs.',
    },
    heroImageId: imageId,
    heroAlt: { nl: 'Zonnepanelen op een rij daken', en: 'Solar panels on a row of roofs' },
    delivery: {
      web: true,
      email: {
        listId: 'nieuwsbrief',
        subject: { nl: 'Nieuws uit de Vogelwijk', en: 'News from the Vogelwijk' },
      },
    },
    blocks: [],
  });
  const header = { nl: await mail(headerDoc, 'nl'), en: await mail(headerDoc, 'en') };
  return { examples, header, imageId, linkedItemId };
}

const exampleItemId = '00000000-0000-4000-8000-0000000e0a11';

function articleBase(nl: string, en: string) {
  return {
    type: 'article' as const,
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl, en },
  };
}
