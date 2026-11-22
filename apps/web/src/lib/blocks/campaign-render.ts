// The campaign parts of the render model that both the landing page and a card need (ADR 038
// rules 2 and 5): when a not yet open campaign opens, in the site's words, and the landing page's
// campaign as its layout shows it. Apart from resolve.ts, which stands at its size ceiling.

import type { CampaignPhase, LandingCampaign } from '@mycel/core';
import type { RenderForm, RenderLanding } from './model.js';

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
