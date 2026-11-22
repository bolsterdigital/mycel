// The campaign parts of the render model that both the landing page and a card need (ADR 038
// rules 2 and 5): when a not yet open campaign opens, in the site's words, and the landing page's
// campaign as its layout shows it. Apart from resolve.ts, which stands at its size ceiling.

import type { CampaignPhase, LandingCampaign } from '@mycel/core';
import type { RenderForm, RenderLanding } from './model.js';

/** Visible fields up to which a campaign form counts as compact (MY-267 PR 5). */
const COMPACT_FIELDS = 4;

/**
 * Whether the action area may stay in view beside a long text (ADR 038 rule 9): only for a short
 * form, so the submit button of a sticky area never sits below the window. A membership form
 * (its tier prices) and anything over four visible fields scroll with the page.
 */
export function compactForm(form: RenderForm | null): boolean {
  if (!form || form.membership) return false;
  return form.fields.filter((f) => f.type !== 'hidden').length <= COMPACT_FIELDS;
}

/** A campaign that has not opened yet, with a known opening: the date in the site's words. */
export function opensOf(
  phase: CampaignPhase,
  opensAt: string | null,
  locale: string,
  timeZone: string
): RenderLanding['opens'] {
  if (phase !== 'upcoming' || !opensAt) return null;
  const label = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone });
  return { iso: opensAt, label: label.format(new Date(opensAt)) };
}

export function renderLanding(
  landing: LandingCampaign,
  forms: ReadonlyMap<string, RenderForm | null>,
  locale: string,
  timeZone: string,
  diagnose = false
): RenderLanding {
  const form = landing.formId ? (forms.get(landing.formId) ?? null) : null;
  const open = landing.phase === 'open';
  return {
    kind: landing.kind,
    phase: landing.phase,
    opens: opensOf(landing.phase, landing.opensAt, locale, timeZone),
    counter: landing.counter,
    form: open || diagnose ? form : null,
    ...(diagnose && !open && form ? { diagnosis: landing.phase as 'upcoming' | 'closed' } : {}),
  };
}
