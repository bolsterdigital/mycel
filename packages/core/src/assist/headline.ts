// A headline proposal reads one thing: the article's own lead in one locale, as the editor wrote
// it. Rejected: the title, blocks or other locales as extra context, which would disclose text the
// task does not need, and a fallback to another locale's lead, which would answer in a language
// the editor did not ask for.

import type { ContentDocument } from '../content/model.js';

/** The longest lead a headline request sends; the article's own lead schema has the same bound. */
export const HEADLINE_SOURCE_MAX = 1000;

export type HeadlineSource = { ok: true; lead: string } | { ok: false; issue: 'headline-source' };

/** The lead of `locale`, trimmed, when it holds words and fits the bound; never another locale. */
export function headlineSource(doc: ContentDocument, locale: string): HeadlineSource {
  const lead = doc.lead?.[locale]?.trim() ?? '';
  return lead && lead.length <= HEADLINE_SOURCE_MAX
    ? { ok: true, lead }
    : { ok: false, issue: 'headline-source' };
}
