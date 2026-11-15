// The public campaign projection a card and a bound form render from (ADR 033 rules 4 and 6): the
// landing page's currently published revision in one locale, the participation phase at the
// moment of reading and the public counter. One function, so the public page, the preview and the
// editor's diagnosis cannot disagree about when a card shows. An unavailable campaign says why;
// the public renderer prints nothing for it, the editor and the authorised preview print the
// reason. Rejected: resolving a card in the renderer from `campaign.get` plus `content.item.get`
// (the publication and access rules would be repeated in a front) and a projection that follows
// the host page's pinned revision (a scheduled host would show a stale count, rule 4).

import { z } from 'zod';
import { Locale } from '../i18n/locale.js';
import { defineUseCase } from '../registry.js';
import type { TransactionContext } from '../ports.js';
import { exampleId } from '../util/ids.js';
import { ContentType, Slug } from '../content/model.js';
import { statusOf } from '../content/lifecycle.js';
import { effectiveOf } from '../content/header/effective.js';
import { acceptsNow, CampaignKind, FORM_KIND_OF, type Campaign } from './model.js';
import './ports.js';
import '../content/ports.js';
import '../theme/ports.js';

/** Why a card renders nothing publicly; the editor and the preview name it. */
export const CampaignCardReason = z.enum([
  /** No such campaign on this site: never made, or another tenant's. */
  'unknown',
  'archived',
  /** The landing page is in the trash. */
  'landing-missing',
  /** The landing page is published in no locale. */
  'draft',
  /** The landing page is published, but not in this locale. */
  'locale-unpublished',
  /** The landing page's published revision is not public (ADR 033 rule 5 keeps this rare). */
  'restricted',
]);
export type CampaignCardReason = z.infer<typeof CampaignCardReason>;

/**
 * Where participation stands for a visitor now: `upcoming` (never opened, or before `opensAt`),
 * `open` (accepts, rule 2) or `closed` (closed, or past `closesAt`).
 */
export const CampaignPhase = z.enum(['upcoming', 'open', 'closed']);
export type CampaignPhase = z.infer<typeof CampaignPhase>;

export const CampaignCard = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(false),
    campaignId: z.string().guid(),
    reason: CampaignCardReason,
  }),
  z.object({
    available: z.literal(true),
    campaignId: z.string().guid(),
    kind: CampaignKind,
    locale: Locale,
    landing: z.object({
      id: z.string().guid(),
      type: ContentType,
      slug: Slug,
      /** The published revision the card shows; part of the host page's ETag (rule 6). */
      revisionId: z.string().guid(),
      /** Where the page is featured elsewhere: its featured title, else its title. */
      title: z.string(),
      /** Its featured description, else its lead, else its first paragraph. */
      summary: z.string().nullable(),
      /** The featured image along the chain (own, hero, the site's default). */
      imageId: z.string().guid().nullable(),
    }),
    phase: CampaignPhase,
    opensAt: z.string().datetime({ offset: true }).nullable(),
    closesAt: z.string().datetime({ offset: true }).nullable(),
    /** Null when the site hides the counter (rule 8): no number anywhere, not even in the ETag. */
    counter: z
      .object({
        participants: z.number().int().nonnegative(),
        target: z.number().int().positive().nullable(),
      })
      .nullable(),
    /** The bound form, only while participation is open; a closed card never offers a submit. */
    formId: z.string().guid().nullable(),
  }),
]);
export type CampaignCard = z.infer<typeof CampaignCard>;

function phaseOf(campaign: Campaign, now: Date): CampaignPhase {
  if (acceptsNow(campaign, now)) return 'open';
  const { state, opensAt, closesAt } = campaign.participation;
  if (state === 'closed' || campaign.archivedAt) return 'closed';
  if (state === 'open' && closesAt && now.getTime() >= Date.parse(closesAt)) return 'closed';
  return 'upcoming';
}

/**
 * The card of one campaign in one locale, evaluated now (ADR 019 rule 4). Reads only: no lock,
 * so a busy campaign does not slow every page that shows it; the submit path re-reads under its
 * own lock and decides (rule 3), which makes a stale card a display delay, never a right.
 */
export async function campaignCardOf(
  ctx: TransactionContext,
  campaign: Campaign | null,
  campaignId: string,
  locale: string
): Promise<CampaignCard> {
  const unavailable = (reason: CampaignCardReason): CampaignCard => ({
    available: false,
    campaignId,
    reason,
  });
  if (!campaign) return unavailable('unknown');
  if (campaign.archivedAt) return unavailable('archived');
  const item = await ctx.content.get(campaign.landingItemId);
  if (!item) return unavailable('landing-missing');
  const live = item.publication.filter((s) => statusOf(s) === 'published');
  const state = live.find((s) => s.locale === locale);
  if (!state?.publishedRevisionId) return unavailable(live.length ? 'locale-unpublished' : 'draft');
  const revision = await ctx.content.revision(item.id, state.publishedRevisionId);
  if (!revision) return unavailable('draft');
  const doc = revision.document;
  if (doc.access.level !== 'public') return unavailable('restricted');

  const now = ctx.clock.now();
  const phase = phaseOf(campaign, now);
  const effective = effectiveOf(doc, locale, (await ctx.siteSettings.images()).value);
  const active = (await ctx.campaigns.activeCounts([campaign.id])).get(campaign.id) ?? 0;
  let formId: string | null = null;
  if (phase === 'open' && campaign.formId) {
    const form = await ctx.forms.findById(campaign.formId);
    if (form && FORM_KIND_OF[campaign.kind] === form.kind) formId = form.id;
  }
  return {
    available: true,
    campaignId: campaign.id,
    kind: campaign.kind,
    locale,
    landing: {
      id: item.id,
      type: item.type,
      slug: item.slug,
      revisionId: revision.id,
      title: effective.title.text,
      summary: effective.summary.text,
      imageId: effective.images.featured.mediaId,
    },
    phase,
    opensAt: campaign.participation.opensAt,
    closesAt: campaign.participation.closesAt,
    counter: campaign.counterVisible
      ? { participants: active + campaign.erasedCount, target: campaign.goal?.target ?? null }
      : null,
    formId,
  };
}

/**
 * The card of the campaign a form is bound to, or null when it is bound to none: what a `form`
 * block shows instead of its fields once participation is not open (rule 2: a closed campaign
 * shows its result and no active submit).
 */
export async function formCampaignCard(
  ctx: TransactionContext,
  formId: string,
  locale: string
): Promise<CampaignCard | null> {
  const campaign = await ctx.campaigns.byForm(formId);
  return campaign ? campaignCardOf(ctx, campaign, campaign.id, locale) : null;
}

export const getCampaignCard = defineUseCase({
  name: 'campaign.card.get',
  kind: 'query',
  requires: 'content:read',
  description:
    "Read a campaign as a card shows it in one locale: its landing page's published title, summary and image, whether participation is open now, and the public count; or why it shows nothing.",
  input: z.object({ campaignId: z.string().guid(), locale: Locale }).strict(),
  output: CampaignCard,
  examples: [{ input: { campaignId: exampleId(0xc1), locale: 'nl' } }],
  async handler(ctx, { campaignId, locale }) {
    return campaignCardOf(ctx, await ctx.campaigns.get(campaignId), campaignId, locale);
  },
});
