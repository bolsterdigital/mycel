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

describe('the plan of the fixture export', () => {
  it('has two pages, three articles, five files, two people and two sections', () => {
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
    expect(result.people.map((p) => p.name)).toEqual(['Anna de Wit', 'Bram Jansen']);
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
