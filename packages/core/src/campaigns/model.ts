// A campaign (ADR 033) is a participation entity beside one landing page: it holds what the page
// cannot (kind, form, participation state and window, goal, archive) and none of the copy, which
// the page owns. Rejected: a third stored content type with its own revisions and read route
// (ADR 033, rejected alternatives), and copy on this row next to the page (two sources drift).
import { z } from 'zod';

export const CampaignKind = z.enum(['petition', 'signup', 'fundraiser']);
export type CampaignKind = z.infer<typeof CampaignKind>;

/**
 * The form kind each campaign kind binds (ADR 033 rule 3): a fundraiser binds a donation form,
 * whose accepted submission opens a payment for the campaign (amendment 2026-11-17).
 */
export const FORM_KIND_OF: Record<CampaignKind, 'petition' | 'signup' | 'donation'> = {
  petition: 'petition',
  signup: 'signup',
  fundraiser: 'donation',
};

const At = z.string().datetime({ offset: true });

/** When participation may start and end; both optional, and an end is after its start. */
export const ParticipationWindow = z
  .object({ opensAt: At.nullable().default(null), closesAt: At.nullable().default(null) })
  .strict()
  .refine((w) => !w.opensAt || !w.closesAt || Date.parse(w.opensAt) < Date.parse(w.closesAt), {
    message: 'campaign.window.closes-before-opens',
    path: ['closesAt'],
  });
export type ParticipationWindow = z.infer<typeof ParticipationWindow>;

/**
 * Participation is separate from publication (ADR 033 rule 2): `draft` has never been opened,
 * `open` accepts when the window and the landing page allow, `closed` accepts nothing.
 */
export const ParticipationState = z.enum(['draft', 'open', 'closed']);
export type ParticipationState = z.infer<typeof ParticipationState>;

export const Participation = z
  .object({ state: ParticipationState, opensAt: At.nullable(), closesAt: At.nullable() })
  .strict();
export type Participation = z.infer<typeof Participation>;

/**
 * A target and milestones in the unit of the kind (ADR 033 rule 8): people for a petition or a
 * signup, minor units of the tenant currency for a fundraiser.
 */
export const CampaignGoal = z
  .object({
    target: z.number().int().positive().max(1_000_000_000_000),
    milestones: z
      .array(z.number().int().positive())
      .max(20)
      .refine((m) => m.every((v, i) => i === 0 || v > m[i - 1]!), 'campaign.goal.milestones-order')
      .default([]),
  })
  .strict()
  .refine((g) => g.milestones.every((m) => m < g.target), {
    message: 'campaign.goal.milestone-above-target',
    path: ['milestones'],
  });
export type CampaignGoal = z.infer<typeof CampaignGoal>;

export const Campaign = z.object({
  id: z.string().guid(),
  kind: CampaignKind,
  landingItemId: z.string().guid(),
  /** Null until a form is bound; a petition or signup cannot open without one. */
  formId: z.string().guid().nullable(),
  participation: Participation,
  goal: CampaignGoal.nullable(),
  /** A tenant may hide the counter (ADR 033 rule 8); the projection then shows no number. */
  counterVisible: z.boolean(),
  /** Confirmed participations of erased supporters, without any identifier (ADR 033 rule 8). */
  erasedCount: z.number().int().nonnegative(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Campaign = z.infer<typeof Campaign>;

/** Money a fundraiser raised: paid amounts in minor units of the tenant currency (rule 8). */
export const Raised = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type Raised = z.infer<typeof Raised>;

/**
 * What a campaign counts now (ADR 033 rule 8). A petition or signup counts people: active
 * participations plus the anonymous erased ones. A fundraiser counts money in `raised`, and
 * `participants` is then the number of paid gifts; its goal is in minor units, like `raised`.
 */
export interface Tally {
  participants: number;
  raised: Raised | null;
}

/**
 * What a reader of a campaign sees (ADR 033 rule 8): the public total, active participations plus
 * the anonymous erased ones, never `erasedCount` on its own. Review point 3 of PR #400: the split
 * says how many people were erased from this campaign, which no `content:read` needs to know.
 */
export const CampaignView = Campaign.omit({ erasedCount: true }).extend({
  participants: z.number().int().nonnegative(),
  /** Set for a fundraiser only: what its paid gifts add up to. */
  raised: Raised.nullable(),
});
export type CampaignView = z.infer<typeof CampaignView>;

export const toView = (campaign: Campaign, tally: Tally): CampaignView => {
  const { erasedCount: _erased, ...rest } = campaign;
  return { ...rest, participants: tally.participants, raised: tally.raised };
};

/**
 * One confirmed participation per campaign and supporter (ADR 033 rule 7). `withdrawnAt` set means
 * it no longer counts; signing again clears it.
 */
export interface CampaignParticipation {
  campaignId: string;
  supporterId: string;
  submissionId: string;
  confirmedAt: string;
  withdrawnAt: string | null;
}

/**
 * Whether a campaign accepts participation now (ADR 033 rule 2), apart from its landing page, which
 * the caller checks: open, not archived and inside its window, evaluated at the moment of use.
 */
export function acceptsNow(campaign: Campaign, now: Date): boolean {
  const { state, opensAt, closesAt } = campaign.participation;
  if (state !== 'open' || campaign.archivedAt) return false;
  if (opensAt && now.getTime() < Date.parse(opensAt)) return false;
  return !(closesAt && now.getTime() >= Date.parse(closesAt));
}

/** What a write may change; kind and landing page are fixed at creation. */
export const CampaignFields = z
  .object({
    formId: z.string().guid().nullable().optional(),
    goal: CampaignGoal.nullable().optional(),
    counterVisible: z.boolean().optional(),
    window: ParticipationWindow.optional(),
  })
  .strict();

/** Whether two windows differ; a changed window changes the public effect (ADR 033 rule 10). */
export const windowChanged = (
  stored: Pick<Participation, 'opensAt' | 'closesAt'>,
  next: ParticipationWindow
): boolean =>
  !sameInstant(stored.opensAt, next.opensAt) || !sameInstant(stored.closesAt, next.closesAt);

const sameInstant = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));
