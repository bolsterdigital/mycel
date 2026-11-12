// The campaign side of the admin (ADR 033): the panel on a landing page's edit screen, the
// form it posts and the outcome it comes back with. The panel sits in the editor's side column,
// which is inside the editor's own form, so its controls belong to a separate form by the `form`
// attribute and post to `campaigns/[id]`; that route answers with a 303 back to the editor and a
// `?campaign=` outcome, so the flow works without JavaScript and a refresh repeats nothing.
// Rejected: actions in the editor route (2,800 lines already, #173) and a nested form (invalid
// HTML; browsers drop the inner one).

import { can, useCases, type CampaignView, type Principal } from '@mycel/core';
import { UseCaseError } from '@mycel/core';
import type { UiKey } from '../../../i18n/index.js';
import { fromLocalInput, localInput } from '../content/content-admin-publication.js';
import { runtime } from '../runtime.js';
import { text } from './admin-actions.js';

/** What the editor's side column shows of the campaign a page is the landing page of. */
export interface CampaignPanel {
  id: string;
  kind: CampaignView['kind'];
  state: CampaignView['participation']['state'];
  archived: boolean;
  participants: number;
  target: number | null;
  counterVisible: boolean;
  opensAt: string;
  closesAt: string;
  baseUpdatedAt: string;
  hasForm: boolean;
  /** Whether this member may open, close and move the window (ADR 033 rule 10). */
  canPublish: boolean;
  canWrite: boolean;
}

export async function campaignPanel(
  principal: Principal,
  itemId: string,
  zone: string
): Promise<CampaignPanel | null> {
  const { campaign } = await runtime().invoker.run(useCases.getLandingCampaign, principal, {
    itemId,
  });
  if (!campaign) return null;
  const local = (at: string | null) => (at ? localInput(new Date(at), zone) : '');
  return {
    id: campaign.id,
    kind: campaign.kind,
    state: campaign.participation.state,
    archived: !!campaign.archivedAt,
    participants: campaign.participants,
    target: campaign.goal?.target ?? null,
    counterVisible: campaign.counterVisible,
    opensAt: local(campaign.participation.opensAt),
    closesAt: local(campaign.participation.closesAt),
    baseUpdatedAt: campaign.updatedAt,
    hasForm: !!campaign.formId,
    canPublish: can(principal, 'content:publish'),
    canWrite: can(principal, 'content:write'),
  };
}

/** The outcomes the panel names after the 303; anything else in `?campaign=` is ignored. */
export const CAMPAIGN_OUTCOMES = {
  created: 'admin.campaign.outcome.created',
  saved: 'admin.campaign.outcome.saved',
  opened: 'admin.campaign.outcome.opened',
  closed: 'admin.campaign.outcome.closed',
  conflict: 'admin.campaign.error.conflict',
  forbidden: 'admin.campaign.error.forbidden',
  'form-required': 'admin.campaign.error.formRequired',
  'form-kind': 'admin.campaign.error.formKind',
  window: 'admin.campaign.error.window',
  goal: 'admin.campaign.error.goal',
  archived: 'admin.campaign.error.archived',
  invalid: 'admin.campaign.error.invalid',
} as const satisfies Record<string, UiKey>;
export type CampaignOutcome = keyof typeof CAMPAIGN_OUTCOMES;

export const campaignOutcome = (value: string | null): CampaignOutcome | null =>
  value && Object.hasOwn(CAMPAIGN_OUTCOMES, value) ? (value as CampaignOutcome) : null;

export const isRefusal = (o: CampaignOutcome) =>
  !['created', 'saved', 'opened', 'closed'].includes(o);

/** The outcome a refusal of a campaign use case is named by, from the issue core put first. */
export function refusalOutcome(e: UseCaseError): CampaignOutcome {
  const issue = e.issues[0]?.message ?? '';
  if (e.code === 'forbidden') return 'forbidden';
  if (issue === 'campaign.archived') return 'archived';
  if (issue.startsWith('campaign.form.required')) return 'form-required';
  if (issue === 'campaign.form.kind-mismatch') return 'form-kind';
  if (issue.startsWith('campaign.window')) return 'window';
  if (issue.startsWith('campaign.goal')) return 'goal';
  if (e.code === 'conflict') return 'conflict';
  return 'invalid';
}

/**
 * The fields of a panel post, as `campaign.update` takes them: the window only when this member
 * may move it (the inputs are not there otherwise), the goal empty for none. `null` for a value
 * that is not a time or not a whole number, which the route answers as `invalid`.
 */
export function campaignFields(data: FormData, zone: string, canPublish: boolean) {
  const at = (name: string) => {
    const value = text(data, name).trim();
    if (!value) return { ok: true as const, at: null };
    const instant = fromLocalInput(value, zone);
    return instant ? { ok: true as const, at: instant.toISOString() } : { ok: false as const };
  };
  const opens = at('opensAt');
  const closes = at('closesAt');
  const targetText = text(data, 'target').trim();
  const target = targetText ? Number(targetText) : null;
  if (!opens.ok || !closes.ok || (target !== null && !Number.isInteger(target))) return null;
  return {
    counterVisible: data.get('counterVisible') === 'on',
    goal: target === null ? null : { target, milestones: [] as number[] },
    ...(canPublish ? { window: { opensAt: opens.at, closesAt: closes.at } } : {}),
  };
}
