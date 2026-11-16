// The licence of an image closes its credit line on the site, linked to its public text where it
// has one, in the words of the page's locale. It belongs to the file, so a block's own credit
// keeps the asset's licence. Rejected: a case in blocks.conformance.test.ts, which sits at the
// file-size ceiling; the hero path runs the same `renderAssetImage` as every image block.
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { MediaLicence, type MediaView } from '@mycel/core';
import Credit from './Credit.svelte';
import { blockCopy, resolveIntro, type ResolveSource } from './resolve.js';

const ID = '01900000-0000-7000-8000-0000000057a1';

const asset = (
  licence: MediaLicence | null,
  photographer: string | null = 'Archief'
): MediaView => ({
  id: ID,
  kind: 'image',
  contentType: 'image/jpeg',
  filename: 'beeld.jpg',
  width: 1600,
  height: 900,
  sizeBytes: 1,
  totalBytes: 1,
  checksum: 'x',
  access: 'public',
  caption: {},
  credit: { work: null, photographer },
  source: null,
  licence,
  focal: { x: 0.5, y: 0.5 },
  state: 'ready',
  usageCount: 1,
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
  variants: [
    { name: 'w640', format: 'webp', width: 640, height: 360, path: `/media/${ID}/w640.webp` },
  ],
});

/** The credit line of a hero image with this asset, as the page renders it. */
async function line(m: MediaView, locale: 'nl' | 'en') {
  const source: ResolveSource = {
    form: async () => null,
    media: async () => m,
    itemPath: async () => null,
  };
  const intro = await resolveIntro(source, { lead: null, heroImageId: ID, heroAlt: null }, locale);
  const credit = intro.hero?.credit;
  if (!credit) return '';
  return render(Credit, { props: { credit, words: blockCopy(locale).credit } }).body.replace(
    /<!--[^>]*-->/g,
    ''
  );
}

describe('the licence of an image', () => {
  for (const [locale, reserved] of [
    ['nl', 'Alle rechten voorbehouden'],
    ['en', 'All rights reserved'],
  ] as const)
    it(`links a Creative Commons licence and names a statement in ${locale}`, async () => {
      const cc = await line(asset({ code: 'cc-by' }), locale);
      expect(cc).toContain(
        '<span class="credit-licence"><a href="https://creativecommons.org/licenses/by/4.0/" rel="license">CC BY 4.0</a></span>'
      );
      expect(cc).toContain('Archief');
      const own = await line(asset({ code: 'all-rights-reserved' }), locale);
      expect(own).toContain(`<span class="credit-licence">${reserved}</span>`);
      expect(own).not.toContain('rel="license"');
    });

  it('names another licence by its own text, and shows a licence without a maker', async () => {
    const html = await line(asset({ code: 'other', text: 'Vrij voor pers' }, null), 'nl');
    expect(html).toContain('<span class="credit-licence">Vrij voor pers</span>');
    expect(html).not.toContain('credit-by');
  });

  it('shows no credit line for an image without maker or licence', async () => {
    expect(await line(asset(null, null), 'nl')).toBe('');
  });

  it('accepts only the closed list, and a name only for another licence', () => {
    expect(MediaLicence.safeParse({ code: 'cc-by' }).success).toBe(true);
    expect(MediaLicence.safeParse({ code: 'other', text: 'X' }).success).toBe(true);
    expect(MediaLicence.safeParse({ code: 'other' }).success).toBe(false);
    expect(MediaLicence.safeParse({ code: 'cc-by', text: 'X' }).success).toBe(false);
    expect(MediaLicence.safeParse({ code: 'CC BY 4.0' }).success).toBe(false);
  });
});
