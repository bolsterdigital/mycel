// Generated share cards: what a link preview
// shows for a published item that has no share image of its own. An editor's
// `seo.imageId` is a full override and gets no card: the head shows exactly that image.
//
// A card is a pure function of its inputs: the title in one locale, the site's heading face and
// primary colours, the item's public photo (featured → hero → site default) and the logo. The
// fingerprint of those inputs is in the blob key (`shareCardKey`), so the head and the job find
// the same file without a table, a changed input is a different key, and the head can only name
// the card of what is published now. A crawler never starts a render: the head names a card
// only once the blob exists, and shows the inherited image until then.
//
// The job renders. Publishing a locale plans `content.share-card` for that revision; a change to
// the theme, the logo or the site's default image plans one `content.share-cards` walk over every
// published locale. Both read the current publication pointer when they run, so a job planned
// for an older revision renders the current one or nothing, and each prunes the item's older
// cards. The bucket stays private: the site route serves the bytes after asking this module
// whether that fingerprint is the current card.
//
// Rejected: a `share_cards` table (a second record of what the key already says, which an export
// and a restore would have to carry), rendering on the first crawler request (a slow, unbounded
// render per URL any visitor can name).
//
// A restricted item has a card too, since its address serves the teaser and has a head (ADR 016
// rule 3): drawn from `cardDocument`, so its title and the public header or featured photo,
// never a block and never an asset that is not `public` (ADR 018 rule 7).

import { z } from 'zod';
import { notFound } from '../../errors.js';
import { Locale } from '../../i18n/locale.js';
import type { JobOutcome } from '../../jobs/ports.js';
import { jobKey, type JobPayload } from '../../jobs/types.js';
import { variantFile, mediaKey, type MediaRecord } from '../../media/model.js';
import type { ShareCardDrawing } from '../../media/ports.js';
import type { TransactionContext } from '../../ports.js';
import { defineUseCase } from '../../registry.js';
import { resolveTheme } from '../../theme/contrast.js';
import { sha256Hex } from '../../util/digest.js';
import { exampleId } from '../../util/ids.js';
import { cardDocument } from '../access/projection.js';
import { effectiveImages } from '../header/effective.js';
import { statusOf } from '../lifecycle.js';
import type { ContentDocument } from '../model.js';
import '../ports.js';
import '../../media/ports.js';
import '../../theme/ports.js';

/** Bumped when the drawing changes, so every card is redrawn under a new key. */
export const SHARE_CARD_VERSION = 1;
/** The photo variant a card reads: the widest webp up to this width. */
const PHOTO_WIDTH = 1280;
/** Cards a walk renders per run before it plans itself again. */
export const SHARE_CARD_BATCH = 20;

export const shareCardPrefix = (tenantId: string, itemId: string, locale: string): string =>
  `tenants/${tenantId}/share-cards/${itemId}/${locale}/`;
export const shareCardKey = (
  tenantId: string,
  itemId: string,
  locale: string,
  fingerprint: string
): string => `${shareCardPrefix(tenantId, itemId, locale)}${fingerprint}.png`;

interface Plan {
  fingerprint: string;
  key: string;
  title: string;
  font: ShareCardDrawing['font'];
  background: string;
  foreground: string;
  photo: { key: string; focal: MediaRecord['focal'] } | null;
  logo: boolean;
}

/**
 * The card of one published locale, or null where it has none: not published, a zone, or a share
 * image of its own. Reads the current pointer, never a planned revision.
 */
async function planCard(
  ctx: TransactionContext,
  itemId: string,
  locale: string
): Promise<Plan | null> {
  const item = await ctx.content.get(itemId);
  if (!item || item.profile === 'zone') return null;
  const state = item.publication.find((s) => s.locale === locale);
  if (!state || statusOf(state) !== 'published') return null;
  const revision = await ctx.content.revision(item.id, state.publishedRevisionId!);
  if (!revision) return null;
  const doc: ContentDocument = cardDocument(revision.document);
  if (doc.seo.imageId) return null;

  const theme = resolveTheme((await ctx.siteSettings.theme()).value);
  const primary = theme.palettes.light.primary;
  const images = (await ctx.siteSettings.images()).value;
  const photo = await photoOf(ctx, effectiveImages(doc, images).featured.mediaId);
  const logo = await ctx.brandAssets.get('logo');
  const title = doc.seo.title?.[locale] ?? doc.title[locale] ?? '';
  const fingerprint = (
    await sha256Hex(
      JSON.stringify([
        SHARE_CARD_VERSION,
        title,
        theme.headingFont,
        primary.background,
        primary.foreground,
        photo?.key ?? null,
        photo?.focal ?? null,
        logo.asset ? logo.version : null,
      ])
    )
  ).slice(0, 24);
  const tenantId = ctx.principal.tenantId;
  return {
    fingerprint,
    key: shareCardKey(tenantId, item.id, locale, fingerprint),
    title,
    font: theme.headingFont,
    background: primary.background,
    foreground: primary.foreground,
    photo,
    logo: !!logo.asset,
  };
}

/** A public, ready image's widest webp variant up to `PHOTO_WIDTH`; anything else is no photo. */
async function photoOf(ctx: TransactionContext, mediaId: string | null): Promise<Plan['photo']> {
  if (!mediaId) return null;
  const asset = await ctx.media.get(mediaId);
  if (!asset || asset.deletedAt || asset.access !== 'public') return null;
  if (asset.kind !== 'image' || asset.state !== 'ready') return null;
  const sized = asset.variants
    .filter((v) => v.format === 'webp' && /^w\d+$/.test(v.name) && v.width)
    .sort((a, b) => a.width! - b.width!);
  const best = [...sized].reverse().find((v) => v.width! <= PHOTO_WIDTH) ?? sized[0];
  if (!best) return null;
  return { key: mediaKey(ctx.principal.tenantId, asset.id, variantFile(best)), focal: asset.focal };
}

export const getShareCard = defineUseCase({
  name: 'content.share_card.get',
  kind: 'query',
  description:
    'The generated share card of one published locale of an item (a restricted one drawn from its teaser): its fingerprint once the card exists, null while it is being made or when the item has a share image of its own.',
  requires: 'content:read',
  input: z.object({ itemId: z.string().guid(), locale: Locale }),
  output: z.object({ card: z.object({ fingerprint: z.string() }).nullable() }),
  examples: [{ input: { itemId: exampleId(0x1), locale: 'nl' } }],
  async handler(ctx, { itemId, locale }) {
    const item = await ctx.content.get(itemId);
    if (!item) throw notFound('content item');
    const plan = await planCard(ctx, itemId, locale);
    if (!plan || !(await ctx.blobs.head(plan.key))) return { card: null };
    return { card: { fingerprint: plan.fingerprint } };
  },
});

/** Plan the card of a revision that just went live; the job reads the pointer again. */
export async function planShareCard(
  ctx: TransactionContext,
  itemId: string,
  locale: string,
  revisionId: string
): Promise<void> {
  await ctx.jobs.enqueue({
    type: 'content.share-card',
    key: jobKey('content.share-card', `${itemId}:${locale}:${revisionId}`),
    runAt: ctx.clock.now(),
    payload: { itemId, locale },
  });
}

/**
 * Plan a walk over every published locale after a site-wide input changed. The key carries the
 * versions of the theme, the site images and the logo, so a change made while a walk runs plans a
 * new one instead of being absorbed by the running one.
 */
export async function planShareCardWalk(ctx: TransactionContext): Promise<void> {
  const [theme, images, logo] = await Promise.all([
    ctx.siteSettings.theme(),
    ctx.siteSettings.images(),
    ctx.brandAssets.get('logo'),
  ]);
  await ctx.jobs.enqueue({
    type: 'content.share-cards',
    key: jobKey(
      'content.share-cards',
      `${ctx.principal.tenantId}:${theme.version}:${images.version}:${logo.version}`
    ),
    runAt: ctx.clock.now(),
    payload: {},
  });
}

/** Render one locale's card if it is missing, and remove its older cards. True: it rendered. */
async function ensureCard(ctx: TransactionContext, itemId: string, locale: string) {
  const plan = await planCard(ctx, itemId, locale);
  const prefix = shareCardPrefix(ctx.principal.tenantId, itemId, locale);
  const stale: string[] = [];
  for await (const { key } of ctx.blobs.list(prefix)) if (key !== plan?.key) stale.push(key);
  let rendered = false;
  if (plan && !(await ctx.blobs.head(plan.key))) {
    const photo = plan.photo ? await ctx.blobs.get(plan.photo.key) : null;
    const logo = plan.logo ? (await ctx.brandAssets.get('logo')).asset : null;
    const bytes = await ctx.images.shareCard({
      title: plan.title,
      font: plan.font,
      background: plan.background,
      foreground: plan.foreground,
      photo: photo && plan.photo ? { bytes: photo, focal: plan.photo.focal } : null,
      logo: logo?.bytes ?? null,
    });
    await ctx.blobs.put(plan.key, bytes, { contentType: 'image/png' });
    rendered = true;
  }
  if (stale.length) await ctx.blobs.delete(stale);
  return rendered;
}

/** The `content.share-card` job (tenant job): one locale of one item. */
export async function renderShareCard(
  ctx: TransactionContext,
  { itemId, locale }: JobPayload<'content.share-card'>
): Promise<JobOutcome> {
  await ensureCard(ctx, itemId, locale);
  return {};
}

/**
 * The `content.share-cards` job (tenant job): every published locale, newest first, at most
 * `SHARE_CARD_BATCH` renders per run; with more to do it plans itself again right away.
 */
export async function renderShareCards(ctx: TransactionContext): Promise<JobOutcome> {
  let after = null;
  let rendered = 0;
  for (;;) {
    const rows = await ctx.content.listPublished({}, after, 100);
    for (const row of rows) {
      if (await ensureCard(ctx, row.itemId, row.locale)) rendered++;
      if (rendered >= SHARE_CARD_BATCH) return { next: ctx.clock.now() };
    }
    const last = rows.at(-1);
    if (!last || rows.length < 100) return {};
    after = { publishedAt: last.publishedAt, itemId: last.itemId, locale: last.locale };
  }
}
