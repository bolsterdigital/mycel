import { readFileSync } from 'node:fs';
import { ContentDocumentInput } from '@mycel/core';
import { describe, expect, it } from 'vitest';
import { plan, placeholder } from './plan.js';
import { formatReport } from './report.js';

const FIXTURE = readFileSync(new URL('../fixtures/dreamkit-export.xml', import.meta.url), 'utf8');
const result = plan(FIXTURE);
const item = (slug: string) => {
  const found = result.items.find((i) => i.slug === slug);
  if (!found) throw new Error(`no item ${slug}`);
  return found;
};

describe('the configured WordPress posts page', () => {
  const xml = FIXTURE.replace(
    '<!-- /wp:file -->]]>',
    '<!-- /wp:file -->\n<!-- wp:wings/nodes-grid {"variationType":"latest","latestPostsCount":4} /-->]]>'
  );

  it('uses a paginated article overview for the posts page in both languages and keeps a teaser grid', () => {
    const regular = plan(xml);
    const imported = plan(xml, { postsPage: { sourceId: 202, pageSize: 12 } });
    const news = imported.items.find((i) => i.slug === 'over-ons')!;
    expect(news.document.locales).toEqual(['nl', 'en']);
    expect(ContentDocumentInput.parse(news.document).blocks).toMatchObject([
      {
        type: 'overview',
        props: { source: 'article', order: 'newest', limit: '12', archive: true, sectionId: null },
      },
    ]);
    const teaser = imported.items.find((i) => i.slug === 'contact')!;
    expect(teaser).toEqual(regular.items.find((i) => i.slug === 'contact'));
    expect(ContentDocumentInput.parse(teaser.document).blocks).toContainEqual(
      expect.objectContaining({
        type: 'overview',
        props: expect.objectContaining({ archive: false, limit: '4' }),
      })
    );
    expect(imported.report.filter((r) => r.code === 'overview.more-dropped')).toMatchObject([
      { postId: 203, detail: 'posts page' },
    ]);
  });

  it('rejects a posts-page id or size that cannot reproduce the archive', () => {
    expect(() => plan(xml, { postsPage: { sourceId: 301, pageSize: 12 } })).toThrow(
      'not a published page in the export'
    );
    expect(() => plan(xml, { postsPage: { sourceId: 203, pageSize: 25 } })).toThrow(
      'Posts page size'
    );
  });
});

describe('the plan of the fixture export', () => {
  it('has two pages, three articles, five files, two authors and two sections', () => {
    expect(result.items.map((i) => [i.document.type, i.slug, i.status])).toEqual([
      ['page', 'over-ons', 'published'],
      ['page', 'contact', 'published'],
      ['article', 'grote-opkomst-bij-klimaatmars', 'published'],
      ['article', 'interview-met-de-voorzitter', 'published'],
      ['article', 'plannen-voor-2027', 'draft'],
    ]);
    expect(result.media.map((m) => m.filename)).toEqual([
      'demonstratie.jpg',
      'vergadering.jpg',
      'bos.jpg',
      'jaarverslag-2025.pdf',
      'gesprek.mp3',
    ]);
    expect(result.people.filter((p) => !p.profile).map((p) => p.name)).toEqual([
      'Anna de Wit',
      'Bram Jansen',
    ]);
    expect(result.sections.map((s) => s.title)).toEqual([
      { nl: 'Nieuws' },
      { nl: 'Acties & campagnes' },
    ]);
  });

  it('makes documents the core accepts', () => {
    for (const planned of result.items)
      expect(ContentDocumentInput.safeParse(planned.document).error?.issues ?? []).toEqual([]);
  });

  it('merges a translation with the same structure into one item', () => {
    const march = item('grote-opkomst-bij-klimaatmars');
    expect(march.sources).toEqual([
      { id: 301, locale: 'nl' },
      { id: 302, locale: 'en' },
    ]);
    expect(march.document.locales).toEqual(['nl', 'en']);
    expect(march.document.title).toEqual({
      nl: 'Grote opkomst bij klimaatmars',
      en: 'Big turnout at climate march',
    });
    expect(march.publishedAt).toBe('2025-03-02T14:30:00Z');
    expect(march.document).toMatchObject({
      authorIds: [placeholder('person', 1)],
      sectionId: placeholder('section', 2),
      tags: ['klimaat'],
      featuredImageId: placeholder('media', 101),
    });
  });

  it('keeps the default language of a translation with another structure and reports the other', () => {
    expect(item('over-ons').document.locales).toEqual(['nl']);
    expect(result.report).toContainEqual(
      expect.objectContaining({ code: 'translation.not-merged', postId: 202, locale: 'en' })
    );
  });

  it('turns the Wings hero into the document header', () => {
    expect(item('over-ons').document).toMatchObject({
      lead: { nl: 'Wij zijn een beweging van gewone mensen.' },
      heroImageId: placeholder('media', 101),
      heroAlt: { nl: 'Mensen met spandoeken op een vol plein' },
    });
    expect(item('over-ons').document.blocks.map((b) => b.type)).not.toContain('hero');
  });

  it('makes the featured image of an article its cover header in a Dreamkit export', () => {
    expect(result.featuredAsHeader).toBe(true);
    expect(item('grote-opkomst-bij-klimaatmars').document).toMatchObject({
      heroImageId: placeholder('media', 101),
      heroAlt: {
        nl: 'Mensen met spandoeken op een vol plein',
        en: 'Mensen met spandoeken op een vol plein',
      },
      featuredImageId: placeholder('media', 101),
      presentation: { header: 'cover' },
    });
    // A page keeps its own header: the cover presentation is an article's (ADR 025 rule 3).
    expect(item('over-ons').document).not.toHaveProperty('presentation');
    const off = plan(FIXTURE, { featuredAsHeader: false }).items.find(
      (i) => i.slug === 'grote-opkomst-bij-klimaatmars'
    )!;
    expect(off.document).not.toHaveProperty('heroImageId');
    expect(off.document).not.toHaveProperty('presentation');
  });

  it('makes Wings people and organisations register entries, without e-mail or phone (MY-281)', () => {
    const profiles = result.people.filter((p) => p.profile);
    expect(profiles.map((p) => [p.name, p.profile!.kind])).toEqual([
      ['Ahmed el Amrani', 'person'],
      ['Buurthuis De Linde', 'organisation'],
      ['Sanne Bakker', 'person'],
    ]);
    expect(profiles[2]).toEqual({
      ref: placeholder('profile', 501),
      sourceLogin: 'sanne-bakker',
      sourceId: 501,
      name: 'Sanne Bakker',
      profile: {
        kind: 'person',
        bio: { nl: 'Woont in de stad & fietst overal heen.' },
        role: { nl: 'Voorzitter' },
        imageId: placeholder('media', 103),
        links: [
          {
            label: 'LinkedIn',
            kind: 'linkedin',
            url: 'https://www.linkedin.com/in/sannebakker/',
          },
          { label: 'Instagram', kind: 'instagram', url: 'https://www.instagram.com/sannebakker' },
        ],
      },
    });
    expect(profiles[1]!.profile).toEqual({
      kind: 'organisation',
      bio: { nl: 'Ons vaste vergaderadres.' },
      links: [{ label: 'Website', kind: 'website', url: 'https://delinde.example' }],
    });
    expect(result.report).toContainEqual(
      expect.objectContaining({ code: 'person.link-invalid', postId: 502 })
    );
  });

  it('makes a person group of a people category with members, in title order', () => {
    expect(result.groups).toEqual([
      {
        ref: placeholder('group', 30),
        sourceTermId: 30,
        name: { nl: 'Bestuur' },
        order: 0,
        personRefs: [placeholder('profile', 502), placeholder('profile', 501)],
      },
    ]);
  });

  it('turns a Wings people grid into a people grid of the group or the selection', () => {
    const grids = item('contact').document.blocks.filter((b) => b.type === 'people-grid');
    expect(grids.map((b) => b.props)).toEqual([
      expect.objectContaining({ source: 'group', groupId: placeholder('group', 30) }),
      expect.objectContaining({
        source: 'selection',
        people: [{ personId: placeholder('profile', 503) }],
        showBio: true,
      }),
    ]);
    expect(result.report).toContainEqual(
      expect.objectContaining({ code: 'people.missing', postId: 203, detail: '999' })
    );
  });

  it('links to an item of the export by id', () => {
    expect(JSON.stringify(item('contact').document.blocks)).toContain(placeholder('item', 201));
  });

  it('reports what does not come over', () => {
    expect(formatReport(result)).toMatchSnapshot();
  });
});

describe('planning choices', () => {
  it('takes the default locale from the caller', () => {
    expect(
      plan(FIXTURE, { defaultLocale: 'en' }).items.find((i) => i.sources[0]?.id === 202)
    ).toBeDefined();
  });

  it('renames a reserved page slug and a second item with the same slug', () => {
    const page = (id: number, slug: string) =>
      `<item><title>T${id}</title><wp:post_id>${id}</wp:post_id><wp:post_name>${slug}</wp:post_name><wp:status>publish</wp:status><wp:post_type>page</wp:post_type><content:encoded><![CDATA[<p>x</p>]]></content:encoded></item>`;
    const twice = plan(
      `<rss><channel><language>nl</language>${page(1, 'en')}${page(2, 'kopie')}${page(3, 'kopie')}</channel></rss>`
    );
    expect(twice.items.map((i) => i.slug)).toEqual(['en-page', 'kopie', 'kopie-2']);
    expect(twice.report.filter((l) => l.code === 'item.slug-changed')).toHaveLength(2);
  });

  it('reports the old and the new address of every changed slug', () => {
    const long = 'a'.repeat(70);
    const post = (id: number, type: string, slug: string) =>
      `<item><title>T${id}</title><link>https://oud.example/${slug}/</link><wp:post_id>${id}</wp:post_id><wp:post_name>${slug}</wp:post_name><wp:status>publish</wp:status><wp:post_type>${type}</wp:post_type><content:encoded><![CDATA[<p>x</p>]]></content:encoded></item>`;
    const changed = plan(
      `<rss><channel><language>nl</language>${post(1, 'page', 'faq')}${post(2, 'post', long)}${post(3, 'page', 'blijft')}</channel></rss>`
    );
    expect(
      changed.report.filter((l) => l.code === 'item.slug-changed').map((l) => l.detail)
    ).toEqual([
      'https://oud.example/faq/ → /faq-page',
      `https://oud.example/${long}/ → /articles/${'a'.repeat(63)}`,
    ]);
    expect(formatReport(changed)).toContain('Addresses changed (old → new) (2)');
  });

  describe('a layout container (MY-282)', () => {
    const page = (content: string) =>
      plan(
        `<rss><channel><language>nl</language><item><title>Voorpagina</title><wp:post_id>1</wp:post_id><wp:post_name>voorpagina</wp:post_name><wp:status>publish</wp:status><wp:post_type>page</wp:post_type><content:encoded><![CDATA[${content}]]></content:encoded></item></channel></rss>`
      );
    const heading = (text: string) =>
      `<!-- wp:heading --><h2 class="wp-block-heading">${text}</h2><!-- /wp:heading -->`;
    const paragraph = (text: string) => `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;

    it('puts the inner blocks of a group in its place and reports its look', () => {
      const result = page(
        `${paragraph('Voor')}<!-- wp:group {"className":"bij1-section bij1-section\\u002d\\u002dcyan"} --><div class="wp-block-group bij1-section">${heading('Wie wij zijn')}${paragraph('Een partij.')}${paragraph('Van iedereen.')}</div><!-- /wp:group -->${paragraph('Na')}`
      );
      const blocks = result.items[0]!.document.blocks;
      expect(blocks.map((b) => b.type)).toEqual(['rich-text', 'heading', 'rich-text']);
      expect(JSON.stringify(blocks)).toContain('Wie wij zijn');
      expect(JSON.stringify(blocks[2])).toContain('Van iedereen.');
      expect(result.report).toEqual([
        expect.objectContaining({
          code: 'block.unwrapped',
          block: 'core/group',
          position: 2,
          detail: 'className=bij1-section bij1-section--cyan',
        }),
      ]);
      expect(result.report.map((l) => l.code)).not.toContain('block.skipped');
    });

    it('unwraps columns and their columns in reading order, silently when they carry no look', () => {
      const result = page(
        `<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column">${heading('Links')}</div><!-- /wp:column --><!-- wp:column --><div class="wp-block-column">${heading('Rechts')}<!-- wp:wings/onbekend /--></div><!-- /wp:column --></div><!-- /wp:columns -->`
      );
      expect(JSON.stringify(result.items[0]!.document.blocks.map((b) => b.props))).toBe(
        JSON.stringify([{ text: { nl: 'Links' } }, { text: { nl: 'Rechts' } }])
      );
      // An unknown block inside is still reported, at the container's top-level position.
      expect(result.report).toEqual([
        expect.objectContaining({ code: 'block.skipped', block: 'wings/onbekend', position: 1 }),
      ]);
    });

    it('unwraps a group nested in a group', () => {
      const result = page(
        `<!-- wp:group {"layout":{"type":"constrained"}} --><div><!-- wp:group {"backgroundColor":"cyan"} --><div>${paragraph('Binnenin')}</div><!-- /wp:group --></div><!-- /wp:group -->`
      );
      expect(JSON.stringify(result.items[0]!.document.blocks)).toContain('Binnenin');
      expect(result.report.map((l) => l.detail)).toEqual(['backgroundColor=cyan']);
    });
  });

  it('keeps a Dreamkit grid of chosen pages and articles as a fixed selection in order (MY-285, MY-289)', () => {
    const post = (id: number, type: string, status = 'publish') =>
      `<item><title>Stuk ${id}</title><wp:post_id>${id}</wp:post_id><wp:post_name>stuk-${id}</wp:post_name><wp:status>${status}</wp:status><wp:post_type>${type}</wp:post_type><content:encoded><![CDATA[]]></content:encoded></item>`;
    const grid = `<!-- wp:wings/nodes-grid {"variationType":"custom","selectedNodes":[12,3,14,13,4,5,11,6,999]} /-->`;
    const result = plan(
      `<rss><channel><language>nl</language><item><title>Voorpagina</title><wp:post_id>1</wp:post_id><wp:post_name>voorpagina</wp:post_name><wp:status>publish</wp:status><wp:post_type>page</wp:post_type><content:encoded><![CDATA[${grid}]]></content:encoded></item>${[3, 4, 5, 6].map((n) => post(n, 'post')).join('')}${[11, 12, 13, 14].map((n) => post(n, 'page')).join('')}${post(15, 'post', 'trash')}</channel></rss>`
    );
    const front = result.items.find((i) => i.slug === 'voorpagina')!;
    const ref = (id: number) => placeholder('item', id);
    expect(front.document.blocks).toEqual([
      expect.objectContaining({
        type: 'overview',
        props: expect.objectContaining({
          source: 'selection',
          pinned: [12, 3, 14, 13, 4, 5, 11, 6].map((id) => ({ itemId: ref(id) })),
        }),
      }),
    ]);
    expect(result.report).toEqual([
      expect.objectContaining({ code: 'items.missing', postId: 1, detail: '999' }),
    ]);
  });

  it('makes a title-replacing hero that opens a page its split header (MY-287)', () => {
    const hero = (id: number) =>
      `<!-- wp:wings/hero {"title":"Rotterdam is van ons","introText":"Een stad voor iedereen.","ctaText":"Word actief","ctaTarget":{"id":${id},"url":"https://oud.example/vacatures/"},"heroImage":{"id":9,"alt":"Kandidaten"},"replacesPageTitle":true} /-->`;
    const post = (id: number, slug: string, type: string, content: string) =>
      `<item><title>${slug}</title><wp:post_id>${id}</wp:post_id><wp:post_name>${slug}</wp:post_name><wp:status>publish</wp:status><wp:post_type>${type}</wp:post_type><content:encoded><![CDATA[${content}]]></content:encoded></item>`;
    const planned = plan(
      `<rss><channel><language>nl</language>
      <item><title>Foto</title><wp:post_id>9</wp:post_id><wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status><wp:attachment_url>https://oud.example/f.jpg</wp:attachment_url></item>
      ${post(1, 'home', 'page', hero(2))}
      ${post(2, 'vacatures', 'page', '<!-- wp:paragraph --><p>Doe mee.</p><!-- /wp:paragraph -->')}
      ${post(3, 'later', 'page', `<!-- wp:paragraph --><p>Eerst tekst.</p><!-- /wp:paragraph -->${hero(2)}`)}
      ${post(4, 'bericht', 'post', hero(2))}
      </channel></rss>`
    );
    const doc = (slug: string) => planned.items.find((i) => i.slug === slug)!.document;
    expect(doc('home')).toMatchObject({
      title: { nl: 'Rotterdam is van ons' },
      lead: { nl: 'Een stad voor iedereen.' },
      heroAlt: { nl: 'Kandidaten' },
      presentation: {
        header: 'split',
        action: {
          label: { nl: 'Word actief' },
          target: { kind: 'item', itemId: placeholder('item', 2) },
        },
      },
    });
    expect(ContentDocumentInput.safeParse(doc('home')).success).toBe(true);
    // Not the first block, or on an article: lead and image only, the button a report line.
    for (const slug of ['later', 'bericht']) {
      expect(doc(slug)).not.toHaveProperty('presentation.action');
      expect(doc(slug)).not.toMatchObject({ presentation: { header: 'split' } });
    }
    expect(planned.report.filter((l) => l.code === 'hero.action-dropped')).toHaveLength(2);
  });

  it('decodes entities in titles, leads and alt texts', () => {
    const decoded = plan(
      `<rss><channel><language>nl</language>
      <item><title><![CDATA[Foto &amp; zo]]></title><wp:post_id>9</wp:post_id><wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status><wp:attachment_url>https://oud.example/f.jpg</wp:attachment_url><wp:postmeta><wp:meta_key>_wp_attachment_image_alt</wp:meta_key><wp:meta_value><![CDATA[Feiten &amp; cijfers op een bord]]></wp:meta_value></wp:postmeta></item>
      <item><title><![CDATA[Feiten &amp; cijfers]]></title><wp:post_id>1</wp:post_id><wp:post_name>feiten</wp:post_name><wp:status>publish</wp:status><wp:post_type>post</wp:post_type><content:encoded><![CDATA[<!-- wp:wings/hero {"introText":"Wat \u0026amp; waarom"} /-->]]></content:encoded><wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>9</wp:meta_value></wp:postmeta></item>
      </channel></rss>`
    );
    expect(decoded.media[0]).toMatchObject({
      title: 'Foto & zo',
      alt: 'Feiten & cijfers op een bord',
    });
    expect(decoded.items[0]!.document).toMatchObject({
      title: { nl: 'Feiten & cijfers' },
      lead: { nl: 'Wat & waarom' },
      heroAlt: { nl: 'Feiten & cijfers op een bord' },
      presentation: { header: 'cover' },
    });
  });
});
