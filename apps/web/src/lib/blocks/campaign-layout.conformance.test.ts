// A campaign's landing page in the campaign layout (ADR 038 rules 2, 3, 5-7; MY-267 PR 2),
// rendered from the real route component per phase and locale with an HTML snapshot each,
// reviewed like the block snapshots: the header image first in `main`, then intro, action area
// and body in that DOM order, one h1, the action area's h2, body headings from h2, the count
// while open, where participation stands otherwise, and no "0 of" when nothing is counted yet.

import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  Block,
  ContentDocument,
  effectiveImages,
  projectDocument,
  type LandingCampaign,
  type MediaView,
} from '@mycel/core';
import { probeForm } from '@mycel/core/testing';
import Page from '../../routes/(public)/[tenant]/[[locale=locale]]/[...path]/+page.svelte';
import { hasForm } from '../server/public/has-form.js';
import { resolveDocument, resolveIntro, type ResolveSource } from './resolve.js';

const HERO = '01900000-0000-7000-8000-0000000267a1';
const FORM = '01900000-0000-7000-8000-0000000267f1';
const ITEM = '01900000-0000-7000-8000-0000000267c1';
const CAMPAIGN = '01900000-0000-7000-8000-0000000267c2';

const hero: MediaView = {
  id: HERO,
  kind: 'image',
  contentType: 'image/jpeg',
  filename: 'zandbank.jpg',
  width: 1600,
  height: 900,
  sizeBytes: 1,
  totalBytes: 1,
  checksum: 'x',
  access: 'public',
  caption: { nl: 'De zandbank bij de stuw', en: 'The sandbank by the weir' },
  credit: { work: null, photographer: 'Archief' },
  source: null,
  licence: null,
  focal: { x: 0.5, y: 0.5 },
  state: 'ready',
  usageCount: 1,
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
  variants: [640, 1280].flatMap((w) =>
    (['avif', 'webp'] as const).map((f) => ({
      name: `w${w}`,
      format: f,
      width: w,
      height: (w * 9) / 16,
      path: `/media/${HERO}/w${w}.${f}`,
    }))
  ),
};

const PROOF = {
  algorithm: 'SHA-256' as const,
  challenge: '0'.repeat(64),
  salt: 'salt',
  maxNumber: 100_000,
  signature: 'signature',
};

const para = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const landing = ContentDocument.parse({
  type: 'page',
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: 'Veilige vistrappen voor de otter', en: 'Safe fish passes for the otter' },
  lead: { nl: 'Vraag de waterbeheerders om hulp.', en: 'Ask the water managers for help.' },
  heroImageId: HERO,
  heroAlt: { nl: 'Een zandbank in de rivier', en: 'A sandbank in the river' },
  blocks: [
    Block.parse({
      id: 'constateren',
      type: 'heading',
      version: 1,
      props: { text: { nl: 'Wij constateren', en: 'We note' } },
    }),
    Block.parse({
      id: 'tekst',
      type: 'rich-text',
      version: 1,
      props: {
        content: {
          nl: para('Otters komen om bij stuwen.'),
          en: para('Otters die at weirs.'),
        },
      },
    }),
    // The campaign's own form placed as a block: renders nothing beside the action area (rule 6).
    Block.parse({
      id: 'eigen-formulier',
      type: 'form',
      version: 1,
      props: { formId: FORM, variant: 'default', width: 'content' },
    }),
  ],
});

const PHASES = {
  open: {
    phase: 'open',
    opensAt: null,
    counter: { participants: 1234, raised: null, target: 5000 },
  },
  upcoming: {
    phase: 'upcoming',
    opensAt: '2026-12-01T09:00:00.000Z',
    counter: { participants: 0, raised: null, target: 5000 },
  },
  closed: {
    phase: 'closed',
    opensAt: null,
    counter: { participants: 0, raised: null, target: 5000 },
  },
} as const;

const prettierConfig = await resolveConfig(fileURLToPath(import.meta.url));

function sourceFor(phase: keyof typeof PHASES): ResolveSource {
  const campaign: LandingCampaign = {
    campaignId: CAMPAIGN,
    kind: 'petition',
    formId: FORM,
    ...PHASES[phase],
    counter: { ...PHASES[phase].counter },
  };
  return {
    form: async (id) =>
      id === FORM ? { form: probeForm(id), startedToken: 'started-token', proof: PROOF } : null,
    media: async (id) => (id === HERO ? hero : null),
    itemPath: async () => null,
    landingCampaign: async (id) => (id === ITEM ? campaign : null),
  };
}

async function page(locale: 'nl' | 'en', phase: keyof typeof PHASES) {
  const source = sourceFor(phase);
  const model = await resolveDocument(
    source,
    { locale, ...projectDocument(landing, locale) },
    { base: '', fallbackLocale: 'nl', itemId: ITEM, timeZone: 'Europe/Amsterdam' }
  );
  const intro = await resolveIntro(
    source,
    {
      lead: landing.lead?.[locale] ?? null,
      heroImageId: effectiveImages(landing).hero.mediaId,
      heroAlt: landing.heroAlt?.[locale] ?? null,
    },
    locale
  );
  const data = {
    view: 'item' as const,
    model,
    intro,
    corrections: null,
    dropCap: false,
    head: {
      canonical: '/',
      alternates: [],
      description: null,
      share: { title: model.title, type: 'website' as const },
      image: null,
    },
    embeds: [],
    errorPrefix: 'Fout:',
  };
  const body = render(Page, { props: { data, form: null } as never }).body.replace(
    /<!--[^>]*-->/g,
    ''
  );
  return { model, html: await format(body, { ...prettierConfig, parser: 'html' }) };
}

describe('a campaign landing page (ADR 038)', () => {
  for (const locale of ['nl', 'en'] as const)
    for (const phase of Object.keys(PHASES) as (keyof typeof PHASES)[])
      it(`renders the campaign layout ${phase} in ${locale}`, async () => {
        const { model, html } = await page(locale, phase);
        await expect(html).toMatchFileSnapshot(
          `__snapshots__/campaign-landing-${phase}.${locale}.html`
        );
        const at = (s: string) => html.indexOf(s);
        // The header image is the first element in main, eager, with its alt in this locale.
        expect(html).toMatch(/<main[^>]*>\s*<figure class="[^"]*campaign-hero/);
        expect(html).toMatch(/<img[^>]*alt="(Een zandbank in de rivier|A sandbank in the river)"/);
        expect(html).not.toContain('loading="lazy"');
        // DOM order intro, action, body; one h1; the action area's h2; body headings from h2.
        expect(at('campaign-intro')).toBeLessThan(at('campaign-action'));
        expect(at('campaign-action')).toBeLessThan(at('campaign-body'));
        expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
        expect(html).toMatch(
          /<section class="campaign-action[^"]*" aria-labelledby="campaign-action">\s*<h2/
        );
        // Sticky only with a compact form to keep in view (MY-267 PR 5): open, not before or after.
        expect(html.includes('campaign-action-sticky')).toBe(phase === 'open');
        expect(html.slice(at('campaign-body'))).toMatch(/<h2[^>]*>\s*(Wij constateren|We note)/);
        // The form only while open, from the campaign; the placed block renders nothing.
        expect(html.match(/<form\s/g)?.length ?? 0).toBe(phase === 'open' ? 1 : 0);
        expect(hasForm(model)).toBe(phase === 'open');
        // The count while open and closed, not before; nothing counted says so, never "0 of".
        expect(html.includes('<progress')).toBe(phase !== 'upcoming');
        expect(html).not.toMatch(/<strong>0<\/strong>|\b0 (van|of)\b/);
        if (phase === 'closed')
          expect(html).toContain(locale === 'nl' ? 'Nog geen handtekeningen' : 'No signatures yet');
        if (phase === 'upcoming')
          expect(html).toContain(locale === 'nl' ? '1 december 2026' : 'December 1, 2026');
        expect(html).not.toMatch(/\sstyle=|<style/);
      });
});
