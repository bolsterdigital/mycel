// A campaign (ADR 033) is a participation entity beside one landing page: it holds what the page
// cannot (kind, form, participation state and window, goal, archive) and none of the copy, which
// the page owns. Rejected: a third stored content type with its own revisions and read route
// (ADR 033, rejected alternatives), and copy on this row next to the page (two sources drift).
import { z } from 'zod';

export const CampaignKind = z.enum(['petition', 'signup', 'fundraiser']);
export type CampaignKind = z.infer<typeof CampaignKind>;

/** The form kind each campaign kind binds (ADR 033 rule 3); a fundraiser waits for ADR 005. */
export const FORM_KIND_OF: Record<CampaignKind, 'petition' | 'signup' | null> = {
  petition: 'petition',
  signup: 'signup',
  fundraiser: null,
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
