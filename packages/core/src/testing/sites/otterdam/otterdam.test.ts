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
import { FakeClock, FakePaymentProvider, MemoryUnitOfWork } from '../../memory.js';
import { supporterIngestSubscriber } from '../../../supporters/service.js';
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
  tier: fake('tier'),
  existing: fake('existing'),
};
const documents = OTTERDAM.items.map((item) => ({ key: item.key, doc: item.document(refs) }));
const blocksOf = (key: string) => documents.find((d) => d.key === key)!.doc.blocks;

describe('Otterdam is complete', () => {
  it('shows every self-contained block type in all its variants on "All blocks"', () => {
    const blocks = blocksOf('test-blokken');
    expect(ALL_BLOCKS_TYPES).toEqual(
      INSERTABLE_BLOCK_TYPES.filter((t) => t !== 'paywall' && t !== 'video')
    );
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
    const published = OTTERDAM.items.filter(
      (i) => i.publishedAt && !i.key.startsWith('test-') && !OTTERDAM.editions?.includes(i.key)
    );
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
    'seeds the whole site and its supporters through the use cases, and a second run makes nothing',
    { timeout: 30_000 },
    async () => {
      const now = new Date('2026-11-21T12:00:00.000Z');
      const provider = new FakePaymentProvider();
      const uow = new MemoryUnitOfWork({ clock: new FakeClock(now), paymentProvider: provider });
      const invoker = new Invoker(buildRegistry(), uow);
      const admin = adminOf();
      const load = async (m: { filename: string; contentType: string }) =>
        m.contentType === 'application/pdf'
          ? reportPdf()
          : m.contentType === 'audio/mpeg'
            ? base64ToBytes(PODCAST_BASE64)
            : JPEG;

      // What the worker would do after commit: here only the ingest, which makes the supporters.
      const ingest = supporterIngestSubscriber(uow);
      const activity = {
        origin: 'http://localhost:5173/otterdam',
        uow,
        deliver: async () => {
          const events = uow.store.outbox.filter((e) => ingest.types.includes(e.type));
          uow.store.outbox.length = 0;
          for (const e of events) await ingest.handle(e);
        },
        settle: async (ref: string) => provider.settle(ref, 'paid'),
      };
      const options = { load, now, activity };
      const first = await seedSite(invoker, admin, OTTERDAM, options);
      expect(first.items.every((s) => s.created)).toBe(true);
      expect(first.created['item']).toHaveLength(OTTERDAM.items.length);
      expect(first.created['navigation']).toEqual(['navigation']);
      // The look: theme, logo and footer text, each only while the tenant has the default.
      expect(first.created).toMatchObject({
        theme: ['theme'],
        logo: ['logo'],
        'footer text': ['footer text'],
      });
      const theme = await invoker.run(useCases.getSiteTheme, admin, {});
      expect(theme.value.chrome).toEqual({ header: 'surface', footer: 'primary' });
      expect(theme.value.palettes.light.primary.background).toBe('#1d7a80');
      expect(await invoker.run(useCases.getBrandAsset, admin, { kind: 'logo' })).toMatchObject({
        active: true,
      });
      const chrome = (await invoker.run(useCases.getSiteChrome, admin, {})).value;
      expect(chrome.footer).toEqual(OTTERDAM.footerText);
      expect(Object.keys(chrome.social ?? {})).toEqual(['bluesky', 'mastodon']);
      // An editor's later choice survives the next run.
      await invoker.run(useCases.updateSiteTheme, admin, {
        baseVersion: theme.version,
        theme: { ...theme.value, radius: 0 },
      });

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

      // The supporters: signatures count, gifts are paid, a member and a reader read the club.
      expect(first.created['supporter']).toHaveLength(OTTERDAM.supporters!.length);
      const count = async (key: string) =>
        (await invoker.run(useCases.getCampaign, admin, { campaignId: first.refs.campaign(key) }))
          .participants;
      expect(await count('vistrappen')).toBe(4);
      expect(await count('otterspotten')).toBe(2);
      const { donations } = await invoker.run(useCases.listDonations, admin, {});
      expect(donations.filter((d) => d.status === 'paid')).toHaveLength(5);
      const { subscriptions } = await invoker.run(useCases.listSubscriptions, admin, {});
      expect(subscriptions.map((s) => [s.interval, s.status]).sort()).toEqual([
        ['month', 'active'],
        ['month', 'active'],
        ['year', 'active'],
      ]);
      const reader = await invoker.run(useCases.getSupporter, admin, {
        email: 'lezer@otterdam.example',
      });
      expect(reader.grants.map((g) => g.tierId)).toEqual([first.refs.tier('leesclub')]);
      const { editions } = await invoker.run(useCases.listEditions, admin, {
        itemId: first.refs.item('nieuwsbrief-november'),
      });
      expect(editions.map((e) => [e.list, e.recipients])).toEqual([['news', 5]]);
      const mail = await invoker.run(useCases.getFormMailSettings, admin, {});
      expect(mail.value.forms[0]!.actions.map((a) => a.kind)).toEqual([
        'notification',
        'notification',
        'notification',
        'receipt',
      ]);

      const second = await seedSite(invoker, admin, OTTERDAM, options);
      expect(second.created).toEqual({});
      expect((await invoker.run(useCases.getSiteTheme, admin, {})).value.radius).toBe(0);
      expect(second.items.map((s) => s.item.id)).toEqual(first.items.map((s) => s.item.id));
    }
  );
});
