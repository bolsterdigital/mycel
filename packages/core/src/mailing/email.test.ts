// What an item becomes as mail: every block type of the registry turns into an e-mail
// form or a sentence linking to the web version, so a new type cannot drop out of mail unnoticed;
// references fail closed as on the site; `mailing.email.get` renders the latest revision through
// the port and needs only `content:read`.

import { beforeAll, describe, expect, it } from 'vitest';
import { BLOCK_TYPES, type BlockType } from '../content/blocks.js';
import { Invoker } from '../invoke.js';
import { systemPrincipal } from '../principal.js';
import {
  EMAIL_SITE,
  emailExamples,
  MemoryUnitOfWork,
  pageDocument,
  principal,
  TENANT,
  type EmailExample,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { EMAIL_FALLBACK_TYPES, type EmailDocument } from './email.js';

let fixture: Awaited<ReturnType<typeof emailExamples>>;
beforeAll(async () => {
  fixture = await emailExamples();
});
const of = (type: BlockType, locale: 'nl' | 'en' = 'nl'): EmailExample =>
  fixture.examples.find((e) => e.type === type && e.locale === locale)!;

describe('an item as mail', () => {
  it('gives every block type an e-mail form or a link to the web version', () => {
    for (const type of BLOCK_TYPES)
      for (const locale of ['nl', 'en'] as const) {
        const { email } = of(type, locale);
        if (type === 'paywall') {
          expect(email.blocks, type).toEqual([]);
          continue;
        }
        expect(email.blocks.length, `${type} ${locale}`).toBeGreaterThan(0);
        const links = email.blocks.filter((b) => b.type === 'link');
        if (EMAIL_FALLBACK_TYPES.includes(type)) {
          expect(links, type).toHaveLength(email.blocks.length);
          for (const l of links) expect(l.href, type).toBe(email.webUrl);
        } else if (type !== 'video-embed') expect(links, type).toEqual([]);
      }
  });

  it('links a video to the video itself, never to an embed', () => {
    const [video] = of('video-embed').email.blocks;
    expect(video).toMatchObject({ type: 'link', href: expect.stringMatching(/^https:\/\//) });
  });

  it('resolves images and item links to absolute public addresses', () => {
    const [image] = of('image').email.blocks;
    expect(image).toMatchObject({
      type: 'image',
      image: {
        src: expect.stringMatching(
          new RegExp(`^${EMAIL_SITE.url}/media/${fixture.imageId}/w\\d+\\.webp$`)
        ),
        alt: 'Demonstranten met spandoeken op het Malieveld',
        caption: 'Het Malieveld op zaterdag',
        credit: 'Foto: Noor Bakker',
      },
    });
    const urls = fixture.examples.flatMap((e) => Object.values(e.email.links));
    expect(urls).toContain(`${EMAIL_SITE.url}/articles/rapport`);
    expect(urls).toContain(`${EMAIL_SITE.url}/en/articles/rapport`);
  });

  it('takes the subject from the e-mail delivery and puts title, lead and hero on top', () => {
    const { nl, en } = fixture.header;
    expect(nl).toMatchObject({
      subject: 'Nieuws uit de Vogelwijk',
      title: 'Een buurtbatterij voor de Vogelwijk',
      lead: expect.stringContaining('veertig daken'),
      hero: { alt: 'Zonnepanelen op een rij daken' },
      webUrl: `${EMAIL_SITE.url}/articles/buurtbatterij`,
      copy: { viewInBrowser: 'Bekijk deze e-mail in je browser' },
    });
    expect(en).toMatchObject({
      subject: 'News from the Vogelwijk',
      webUrl: `${EMAIL_SITE.url}/en/articles/buurtbatterij`,
      copy: { viewInBrowser: 'View this e-mail in your browser' },
    });
  });
});

describe('mailing.email.get', () => {
  it('renders the latest revision through the renderer port with only content:read', async () => {
    const seen: EmailDocument[] = [];
    const uow = new MemoryUnitOfWork({
      emailRenderer: { render: (e) => (seen.push(e), { html: '<p>html</p>', text: 'text' }) },
    });
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = systemPrincipal(TENANT, 'test');
    const created = await invoker.run(useCases.createItem, admin, {
      slug: 'concept',
      document: pageDocument({
        title: { nl: 'Concept', en: 'Draft' },
        // Unpublished and private: a preview shows it, a link to it would not resolve.
        access: { level: 'members' as const, teaser: 'lead' as const },
      }),
    });
    const out = await invoker.run(
      useCases.getEmail,
      principal({
        actor: { kind: 'operator', operatorId: '01900000-0000-7000-8000-00000000a001' },
        capabilities: ['content:read'],
      }),
      { itemId: created.item.id, locale: 'en', site: EMAIL_SITE }
    );
    expect(out).toEqual({ subject: 'Draft', html: '<p>html</p>', text: 'text' });
    expect(seen[0]).toMatchObject({ title: 'Draft', webUrl: `${EMAIL_SITE.url}/en/concept` });
  });
});
