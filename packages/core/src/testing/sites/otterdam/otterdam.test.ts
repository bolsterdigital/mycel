// Otterdam stays complete and valid as Mycel grows: "All blocks" has every insertable block type
// in every variant value, the site uses both article headers, every page profile a tester can
// see and both kinds of register entry, every custom block outside the deliberate test page has
// a paragraph on both sides, and the runner seeds the whole site through the use cases once:
// a second run makes nothing.

import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS } from '../../../content/block-types.js';
import { INSERTABLE_BLOCK_TYPES } from '../../../content/blocks.js';
import { Invoker } from '../../../invoke.js';
import { buildRegistry, useCases } from '../../../use-cases.js';
import { base64ToBytes } from '../../../util/bytes.js';
import { exampleId } from '../../../util/ids.js';
import { adminOf } from '../../fixtures.js';
import { FakeClock, MemoryUnitOfWork } from '../../memory.js';
import type { SiteRefs } from '../runner.js';
import { seedSite } from '../runner.js';
import { OTTERDAM, PODCAST_BASE64, reportPdf } from './index.js';
import { ALL_BLOCKS_TYPES, CROWDED_ON_PURPOSE } from './tests.js';

let n = 0;
const ids = new Map<string, string>();
const fake = (kind: string) => (key: string) => {
  const k = `${kind}:${key}`;
  if (!ids.has(k)) ids.set(k, exampleId(0x5000 + n++));
  return ids.get(k)!;
};
const refs: SiteRefs = {
  media: fake('media'),
  person: fake('person'),
  group: fake('group'),
  section: fake('section'),
  form: fake('form'),
  item: fake('item'),
  campaign: fake('campaign'),
  pattern: fake('pattern'),
};
const documents = OTTERDAM.items.map((item) => ({ key: item.key, doc: item.document(refs) }));
const blocksOf = (key: string) => documents.find((d) => d.key === key)!.doc.blocks;

describe('Otterdam is complete', () => {
  it('shows every insertable block type but the paywall, in every variant value, on "All blocks"', () => {
    const blocks = blocksOf('test-blokken');
    expect(ALL_BLOCKS_TYPES).toEqual(INSERTABLE_BLOCK_TYPES.filter((t) => t !== 'paywall'));
    for (const type of ALL_BLOCKS_TYPES) {
      const used = blocks.filter((b) => b.type === type);
      expect([type, used.length > 0]).toEqual([type, true]);
      for (const b of used)
        expect([type, b.version]).toEqual([type, BLOCK_DEFINITIONS[type].version]);
      for (const [prop, values] of Object.entries(BLOCK_DEFINITIONS[type].variants))
        for (const value of values)
          expect([
            type,
            prop,
            value,
            used.some((b) => (b.props as Record<string, unknown>)[prop] === value),
          ]).toEqual([type, prop, value, true]);
    }
  });

  it('uses the paywall, both article headers, the event and dossier profiles and both register kinds, never a hero', () => {
    const all = documents.flatMap((d) => d.doc.blocks.map((b) => b.type));
    expect(all).toContain('paywall');
    expect(all).not.toContain('hero');
    const articles = documents.map((d) => d.doc).filter((d) => d.type === 'article');
    const headers = new Set(
      articles.map((d) => (d.type === 'article' && d.presentation?.header) || 'standard')
    );
    expect([...headers].sort()).toEqual(['cover', 'standard']);
    const profiles = new Set(documents.map((d) => d.doc.type === 'page' && d.doc.profile));
    expect(profiles.has('event') && profiles.has('dossier')).toBe(true);
    const kinds = new Set(OTTERDAM.people.map((p) => p.person.kind ?? 'person'));
    expect([...kinds].sort()).toEqual(['organisation', 'person']);
  });

  it('has about twenty published articles spread over a year and a half', () => {
    const published = OTTERDAM.items.filter((i) => i.publishedAt && !i.key.startsWith('test-'));
    const dates = published.map((i) => i.publishedAt!).sort();
    expect(published.length).toBe(20);
    expect(Date.parse(dates.at(-1)!) - Date.parse(dates[0]!)).toBeGreaterThan(400 * 86_400_000);
  });
});

/** Jaap, P185-79: a custom block never follows another; a paragraph stands before and after it. */
const PLAIN = new Set(['rich-text', 'heading', 'image', 'paywall']);
const hasParagraph = (b: { type: string; props: unknown } | undefined) =>
  b?.type === 'rich-text' && JSON.stringify(b.props).includes('"paragraph"');

describe('Otterdam rhythm', () => {
  it.each(
    documents
      .filter((d) => !CROWDED_ON_PURPOSE.includes(d.key))
      .map((d) => [d.key, d.doc.blocks] as const)
  )('%s has a paragraph on both sides of every custom block', (_key, all) => {
    const blocks = all.filter((b) => b.type !== 'paywall' && b.type !== 'heading');
    const crowded = blocks.flatMap((b, i) =>
      !PLAIN.has(b.type) && !(hasParagraph(blocks[i - 1]) && hasParagraph(blocks[i + 1]))
        ? [`${i}: ${b.type}`]
        : []
    );
    expect(crowded).toEqual([]);
  });
});

/** A JPEG start-of-image marker: all the memory image processor reads of a JPEG. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

describe('seedSite with Otterdam', () => {
  it(
    'seeds the whole site through the use cases, and a second run makes nothing',
    { timeout: 30_000 },
    async () => {
      const now = new Date('2026-11-21T12:00:00.000Z');
      const uow = new MemoryUnitOfWork({ clock: new FakeClock(now) });
      const invoker = new Invoker(buildRegistry(), uow);
      const admin = adminOf();
      const load = async (m: { filename: string; contentType: string }) =>
        m.contentType === 'application/pdf'
          ? reportPdf()
          : m.contentType === 'audio/mpeg'
            ? base64ToBytes(PODCAST_BASE64)
            : JPEG;

      const first = await seedSite(invoker, admin, OTTERDAM, load, now);
      expect(first.items.every((s) => s.created)).toBe(true);
      expect(first.created['item']).toHaveLength(OTTERDAM.items.length);
      expect(first.created['navigation']).toEqual(['navigation']);

      const item = (key: string) => first.items.find((s) => s.key === key)!.item;
      const status = (key: string, locale = 'nl') =>
        item(key).publication.find((p) => p.locale === locale)?.status;
      expect(status('home', 'en')).toBe('published');
      expect(status('kerst')).toBe('scheduled');
      expect(status('concept')).toBe('draft');
      expect(item('eerste-singel').publication[0]!.firstPublishedAt).toBe(
        '2025-05-20T08:00:00.000Z'
      );
      const winter = item('winter').publication.find((p) => p.locale === 'en')!;
      expect(winter.status).toBe('published');
      expect(winter.hasUnpublishedChanges).toBe(true);
      const { revisions } = await invoker.run(useCases.listRevisions, admin, {
        itemId: item('vrijwilliger').id,
      });
      expect(revisions.length).toBeGreaterThanOrEqual(4);
      const campaign = await invoker.run(useCases.getCampaign, admin, {
        campaignId: first.refs.campaign('vistrappen'),
      });
      expect(campaign.participation.state).toBe('open');

      const second = await seedSite(invoker, admin, OTTERDAM, load, now);
      expect(second.created).toEqual({});
      expect(second.items.map((s) => s.item.id)).toEqual(first.items.map((s) => s.item.id));
    }
  );
});
