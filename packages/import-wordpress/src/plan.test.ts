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
});
