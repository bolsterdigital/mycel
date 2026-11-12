// Campaign use cases (ADR 033): create binds an existing page as the landing page and, optionally,
// a form; update changes the campaign's own fields on a base (ADR 027); open, close and archive
// change participation and therefore the public effect, so they need `content:publish`, as does
// an update that moves the window (rule 10). Participation itself (rules 3, 7, 8) is decided on
// the submit path (`participationFor`) and recorded where the supporter id exists, at ingest of
// the confirmed signature (`recordConfirmed`).
// Rejected: a create that also makes the page and the form here, which would duplicate
// `content.item.create` and `form.create`; the admin flow composes them.

import { z } from 'zod';
import { notFound, UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import { can, type Capability } from '../principal.js';
import { defineUseCase } from '../registry.js';
import { exampleId } from '../util/ids.js';
import { MAX_PAGE_SIZE } from '../util/page-size.js';
import { lockItem } from '../content/service.js';
import type { ItemRecord } from '../content/ports.js';
import {
  acceptsNow,
  Campaign,
  CampaignFields,
  CampaignView,
  toView,
  CampaignGoal,
  CampaignKind,
  FORM_KIND_OF,
  ParticipationWindow,
  windowChanged,
} from './model.js';
import './ports.js';

const CampaignId = z.string().guid();
const IsoDate = z.string().datetime({ offset: true });
/** How many referring items a refusal looks at and names, as `content.item.delete` does. */
const REFERRERS_LOOKED_AT = 50;
const REFERRERS_NAMED = 3;

const refuse = (
  code: 'conflict' | 'invalid_input' | 'forbidden',
  path: string,
  message: string,
  params?: Record<string, string>
) => new UseCaseError(code, message, [{ path, message, ...(params ? { params } : {}) }]);

function requireCapability(ctx: TransactionContext, capability: Capability, path: string) {
  if (!can(ctx.principal, capability))
    throw refuse('forbidden', path, `campaign.forbidden.${capability.replace(':', '-')}`);
}

async function lockCampaign(ctx: TransactionContext, id: string): Promise<Campaign> {
  const campaign = await ctx.campaigns.lock(id);
  if (!campaign) throw notFound('campaign');
  return campaign;
}

const notArchived = (campaign: Campaign) => {
  if (campaign.archivedAt) throw refuse('conflict', 'campaignId', 'campaign.archived');
};

/**
 * Every revision of the item that is or may become public must be public (ADR 033 rule 5): the
 * latest, each published and each scheduled one. Later saves are held by `storeRevision`.
 */
async function assertPublicLanding(ctx: TransactionContext, item: ItemRecord) {
  const ids = new Set([item.latestRevisionId]);
  for (const s of item.publication) {
    if (s.publishedRevisionId) ids.add(s.publishedRevisionId);
    if (s.scheduledRevisionId) ids.add(s.scheduledRevisionId);
  }
  for (const id of ids) {
    const revision = await ctx.content.revision(item.id, id);
    if (revision && revision.document.access.level !== 'public')
      throw refuse('conflict', 'landingItemId', 'campaign.landing.restricted');
  }
}

/** Lock and check a form for this campaign: it exists, fits the kind and is bound to no other. */
async function bindableForm(
  ctx: TransactionContext,
  kind: CampaignKind,
  formId: string,
  campaignId: string | null
) {
  requireCapability(ctx, 'forms:write', 'formId');
  const form = await ctx.forms.lock(formId);
  if (!form) throw notFound('form');
  if (FORM_KIND_OF[kind] !== form.kind)
    throw refuse('invalid_input', 'formId', 'campaign.form.kind-mismatch', {
      kind,
      formKind: form.kind,
    });
  const holder = await ctx.campaigns.byForm(formId);
  if (holder && holder.id !== campaignId) throw refuse('conflict', 'formId', 'campaign.form.bound');
}

/** A stamp after `base`, so a compare-and-set on the new value never meets the old one. */
const nextStamp = (ctx: TransactionContext, base: string) =>
  new Date(Math.max(ctx.clock.now().getTime(), Date.parse(base) + 1)).toISOString();

const conflict = () => refuse('conflict', 'baseUpdatedAt', 'campaign.conflict');

/** The reader's view of campaigns: the public total, never the erased count on its own. */
async function views(ctx: TransactionContext, campaigns: Campaign[]): Promise<CampaignView[]> {
  const active = await ctx.campaigns.activeCounts(campaigns.map((c) => c.id));
  return campaigns.map((c) => toView(c, active.get(c.id) ?? 0));
}
const view = async (ctx: TransactionContext, campaign: Campaign) =>
  (await views(ctx, [campaign]))[0]!;

/** Write a changed campaign on the base the caller read, or refuse with the one conflict. */
async function save(ctx: TransactionContext, campaign: Campaign, base: string) {
  const next = { ...campaign, updatedAt: nextStamp(ctx, base) };
  if (!(await ctx.campaigns.update(next, base))) throw conflict();
  return view(ctx, next);
}

export const createCampaign = defineUseCase({
  name: 'campaign.create',
  kind: 'command',
  requires: 'content:write',
  consumes: null,
  description:
    'Make a page the landing page of a new petition, signup or fundraiser, optionally binding a form of the matching kind; participation starts closed as a draft.',
  input: z
    .object({
      kind: CampaignKind,
      landingItemId: z.string().guid(),
      formId: z.string().guid().nullable().default(null),
      goal: CampaignGoal.nullable().default(null),
      counterVisible: z.boolean().default(true),
      window: ParticipationWindow.default({ opensAt: null, closesAt: null }),
    })
    .strict(),
  output: CampaignView,
  examples: [{ input: { kind: 'petition', landingItemId: exampleId(0x1) } }],
  async handler(ctx, { kind, landingItemId, formId, goal, counterVisible, window }) {
    const item = await lockItem(ctx, landingItemId);
    if (item.type !== 'page')
      throw refuse('invalid_input', 'landingItemId', 'campaign.landing.not-a-page');
    if (await ctx.campaigns.byLandingItem(landingItemId))
      throw refuse('conflict', 'landingItemId', 'campaign.landing.bound');
    await assertPublicLanding(ctx, item);
    const id = ctx.ids.next();
    if (formId) await bindableForm(ctx, kind, formId, id);
    if (window.opensAt || window.closesAt) requireCapability(ctx, 'content:publish', 'window');
    const now = ctx.clock.now().toISOString();
    const campaign: Campaign = {
      id,
      kind,
      landingItemId,
      formId,
      participation: { state: 'draft', ...window },
      goal,
      counterVisible,
      erasedCount: 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await ctx.campaigns.insert(campaign)))
      throw refuse('conflict', 'landingItemId', 'campaign.landing.bound');
    return view(ctx, campaign);
  },
});

export const updateCampaign = defineUseCase({
  name: 'campaign.update',
  kind: 'command',
  requires: 'content:write',
  description:
    'Change the form, goal, counter visibility or participation window of a campaign on the timestamp read by the caller; moving the window also requires publishing permission.',
  input: CampaignFields.extend({ campaignId: CampaignId, baseUpdatedAt: IsoDate }).strict(),
  output: CampaignView,
  examples: [
    {
      input: {
        campaignId: exampleId(0xc1),
        baseUpdatedAt: '2026-11-12T09:00:00.000Z',
        counterVisible: false,
      },
    },
  ],
  async handler(ctx, { campaignId, baseUpdatedAt, formId, goal, counterVisible, window }) {
    const current = await lockCampaign(ctx, campaignId);
    if (Date.parse(current.updatedAt) !== Date.parse(baseUpdatedAt)) throw conflict();
    notArchived(current);
    // The window check compares stored and requested values inside this transaction (rule 10),
    // so a write-only principal edits everything else and gets a typed refusal for the window.
    if (window && windowChanged(current.participation, window))
      requireCapability(ctx, 'content:publish', 'window');
    if (formId !== undefined && formId !== current.formId) {
      if (formId) await bindableForm(ctx, current.kind, formId, current.id);
      else if (current.participation.state === 'open')
        throw refuse('conflict', 'formId', 'campaign.form.required-while-open');
      else requireCapability(ctx, 'forms:write', 'formId');
    }
    return save(
      ctx,
      {
        ...current,
        ...(formId !== undefined ? { formId } : {}),
        ...(goal !== undefined ? { goal } : {}),
        ...(counterVisible !== undefined ? { counterVisible } : {}),
        ...(window ? { participation: { ...current.participation, ...window } } : {}),
      },
      baseUpdatedAt
    );
  },
});

const StateChange = z.object({ campaignId: CampaignId, baseUpdatedAt: IsoDate }).strict();

export const openCampaign = defineUseCase({
  name: 'campaign.open',
  kind: 'command',
  requires: 'content:publish',
  effect: 'publish',
  description:
    'Open participation. Publishing the landing page stays separate: a campaign accepts only while its page is published, inside its window.',
  input: StateChange,
  output: CampaignView,
  examples: [{ input: { campaignId: exampleId(0xc1), baseUpdatedAt: '2026-11-12T09:00:00.000Z' } }],
  async handler(ctx, { campaignId, baseUpdatedAt }) {
    const current = await lockCampaign(ctx, campaignId);
    if (Date.parse(current.updatedAt) !== Date.parse(baseUpdatedAt)) throw conflict();
    notArchived(current);
    if (FORM_KIND_OF[current.kind] === null)
      throw refuse('conflict', 'campaignId', 'campaign.kind.not-available', { kind: current.kind });
    if (!current.formId) throw refuse('conflict', 'formId', 'campaign.form.required');
    // Rule 3 at the moment it matters. `form.update` refuses to change a bound form's kind; this
    // read under the form's lock is the backstop for a form bound before that guard existed.
    const form = await ctx.forms.lock(current.formId);
    if (!form) throw notFound('form');
    if (FORM_KIND_OF[current.kind] !== form.kind)
      throw refuse('conflict', 'formId', 'campaign.form.kind-mismatch', {
        kind: current.kind,
        formKind: form.kind,
      });
    if (current.participation.state === 'open') return view(ctx, current);
    return save(
      ctx,
      { ...current, participation: { ...current.participation, state: 'open' } },
      baseUpdatedAt
    );
  },
});

export const closeCampaign = defineUseCase({
  name: 'campaign.close',
  kind: 'command',
  requires: 'content:publish',
  effect: 'publish',
  description:
    'Close participation; the landing page stays as it is and shows the result without a form.',
  input: StateChange,
  output: CampaignView,
  examples: [{ input: { campaignId: exampleId(0xc1), baseUpdatedAt: '2026-11-12T09:00:00.000Z' } }],
  async handler(ctx, { campaignId, baseUpdatedAt }) {
    const current = await lockCampaign(ctx, campaignId);
    if (Date.parse(current.updatedAt) !== Date.parse(baseUpdatedAt)) throw conflict();
    notArchived(current);
    if (current.participation.state === 'closed') return view(ctx, current);
    return save(
      ctx,
      { ...current, participation: { ...current.participation, state: 'closed' } },
      baseUpdatedAt
    );
  },
});

const titleOf = (item: ItemRecord) => item.title[item.defaultLocale] ?? item.slug;

export const archiveCampaign = defineUseCase({
  name: 'campaign.archive',
  kind: 'command',
  requires: 'content:publish',
  effect: 'publish',
  description:
    'Archive a campaign: participation closes and it leaves card selection; refused while a published page or article shows a card for it, naming them. Nothing is deleted.',
  input: StateChange,
  output: CampaignView,
  examples: [{ input: { campaignId: exampleId(0xc1), baseUpdatedAt: '2026-11-12T09:00:00.000Z' } }],
  async handler(ctx, { campaignId, baseUpdatedAt }) {
    const current = await lockCampaign(ctx, campaignId);
    if (Date.parse(current.updatedAt) !== Date.parse(baseUpdatedAt)) throw conflict();
    notArchived(current);
    const ref = { type: 'campaign', id: campaignId } as const;
    if (await ctx.content.liveReferences(ref)) {
      const page = await ctx.content.find({ ref, live: true }, null, REFERRERS_LOOKED_AT);
      throw refuse('conflict', 'campaignId', 'campaign.archive.referenced', {
        count: String(page.rows.length),
        titles: page.rows
          .slice(0, REFERRERS_NAMED)
          .map((r) => titleOf(r.item))
          .join(', '),
      });
    }
    return save(
      ctx,
      {
        ...current,
        participation: { ...current.participation, state: 'closed' },
        archivedAt: ctx.clock.now().toISOString(),
      },
      baseUpdatedAt
    );
  },
});

export const getCampaign = defineUseCase({
  name: 'campaign.get',
  kind: 'query',
  requires: 'content:read',
  description: 'Read a campaign: kind, landing page, form, participation, goal and archive state.',
  input: z.object({ campaignId: CampaignId }).strict(),
  output: CampaignView,
  examples: [{ input: { campaignId: exampleId(0xc1) } }],
  async handler(ctx, { campaignId }) {
    const campaign = await ctx.campaigns.get(campaignId);
    if (!campaign) throw notFound('campaign');
    return view(ctx, campaign);
  },
});

export const listCampaigns = defineUseCase({
  name: 'campaign.list',
  kind: 'query',
  requires: 'content:read',
  description:
    'List the campaigns of this site, newest first: the active ones, or with `archived` the archived ones.',
  input: z
    .object({
      kind: CampaignKind.optional(),
      archived: z.boolean().default(false),
      offset: z.number().int().nonnegative().max(100_000).default(0),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
    })
    .strict(),
  output: z.object({
    campaigns: z.array(CampaignView),
    nextOffset: z.number().int().nullable(),
  }),
  examples: [{ input: {} }],
  async handler(ctx, { kind, archived, offset, limit }) {
    const rows = await ctx.campaigns.list({ kind, archived }, offset, limit + 1);
    return {
      campaigns: await views(ctx, rows.slice(0, limit)),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  },
});

/**
 * The campaign a submission to `formId` takes part in, or null when the form is bound to none
 * (ADR 033 rule 3). Throws `campaign.closed` when the campaign does not accept participation now:
 * not open, archived, outside its window, or its landing page not published and public in the
 * submitting locale. Re-read under a share lock inside the submission's transaction, so a stale
 * page, a reposted form or an old tab cannot add a submission after closing. `lock: false` is the
 * cheap early refusal before the spam and rate-limit writes; only the locked read decides.
 */
export async function participationFor(
  ctx: TransactionContext,
  form: { id: string; kind: string },
  locale: string,
  now: Date,
  { lock = true }: { lock?: boolean } = {}
): Promise<Campaign | null> {
  const campaign = await (lock
    ? ctx.campaigns.shareByForm(form.id)
    : ctx.campaigns.byForm(form.id));
  if (!campaign) return null;
  const closed = () => refuse('conflict', 'formId', 'campaign.closed');
  if (FORM_KIND_OF[campaign.kind] !== form.kind || !acceptsNow(campaign, now)) throw closed();
  const landing = await ctx.content.get(campaign.landingItemId);
  const published = landing?.publication.find((s) => s.locale === locale)?.publishedRevisionId;
  if (!landing || !published) throw closed();
  const revision = await ctx.content.revision(landing.id, published);
  if (!revision || revision.document.access.level !== 'public') throw closed();
  return campaign;
}

/**
 * Record a confirmed signature once its supporter id exists, in the ingest transaction of the
 * `petition.signed` or `form.submitted` event (ADR 033 rule 7). A campaign that is gone counts
 * nothing; an archived or closed one still counts a signature submitted while it was open.
 */
export async function recordConfirmed(
  ctx: TransactionContext,
  p: { campaignId: string; supporterId: string; submissionId: string; confirmedAt: string }
) {
  if (!(await ctx.campaigns.get(p.campaignId))) return 'unchanged' as const;
  return ctx.campaigns.recordParticipation(p);
}

export const withdrawParticipation = defineUseCase({
  name: 'campaign.participation.withdraw',
  kind: 'command',
  requires: 'supporters:write',
  description:
    "Withdraw a supporter's signature or signup from a campaign at their request: it stops counting and the record of the confirmation stays; signing again restores it.",
  input: z.object({ campaignId: CampaignId, supporterId: z.string().guid() }).strict(),
  output: z.object({ withdrawn: z.boolean(), campaign: CampaignView }),
  examples: [{ input: { campaignId: exampleId(0xc1), supporterId: exampleId(0x5) } }],
  async handler(ctx, { campaignId, supporterId }) {
    const campaign = await ctx.campaigns.get(campaignId);
    if (!campaign) throw notFound('campaign');
    const withdrawn = await ctx.campaigns.withdrawParticipation(
      campaignId,
      supporterId,
      ctx.clock.now().toISOString()
    );
    return { withdrawn, campaign: await view(ctx, campaign) };
  },
});
