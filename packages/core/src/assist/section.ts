// A section proposal reads two things: the article's own lead in one locale and the site's
// sections that have a title in that locale. The candidate list is complete or it is not offered:
// a partial list would let the model pick from a choice the editor never saw. Rejected: section
// descriptions, slugs or the article title as extra context, which the choice does not need.

import type { ContentDocument, Section } from '../content/model.js';
import type { TransactionContext } from '../ports.js';
import { sha256Hex } from '../util/digest.js';
import { MAX_PAGE_SIZE } from '../util/page-size.js';

/** The lead bounds of a section request: enough words to judge, no more than the lead schema. */
export const SECTION_LEAD_MIN = 50;
export const SECTION_LEAD_MAX = 1000;
/** A choice needs at least two sections; more than twenty, or long titles, is not a short list. */
export const SECTION_CANDIDATES_MIN = 2;
export const SECTION_CANDIDATES_MAX = 20;
export const SECTION_TITLES_MAX = 2000;

export interface SectionCandidate {
  id: string;
  title: string;
}

export type SectionLead = { ok: true; lead: string } | { ok: false; issue: 'section-source' };

/** The lead of `locale`, trimmed, when it is 50 to 1,000 characters; never another locale. */
export function sectionLead(doc: ContentDocument, locale: string): SectionLead {
  const lead = doc.lead?.[locale]?.trim() ?? '';
  return lead.length >= SECTION_LEAD_MIN && lead.length <= SECTION_LEAD_MAX
    ? { ok: true, lead }
    : { ok: false, issue: 'section-source' };
}

export type SectionCandidates =
  { ok: true; candidates: SectionCandidate[] } | { ok: false; issue: 'section-candidates' };

/**
 * Every section with a title in `locale`, in id order, from the complete list; refused when that
 * is fewer than two, more than twenty or more than 2,000 title characters together.
 */
export function sectionCandidates(
  sections: readonly Pick<Section, 'id' | 'title'>[],
  locale: string
): SectionCandidates {
  const candidates = sections
    .flatMap((s) => {
      const title = s.title[locale]?.trim();
      return title ? [{ id: s.id, title }] : [];
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const length = candidates.reduce((sum, c) => sum + c.title.length, 0);
  return candidates.length >= SECTION_CANDIDATES_MIN &&
    candidates.length <= SECTION_CANDIDATES_MAX &&
    length <= SECTION_TITLES_MAX
    ? { ok: true, candidates }
    : { ok: false, issue: 'section-candidates' };
}

/** The candidates of `locale` read from every page of the site's sections, never one page. */
export async function readSectionCandidates(
  ctx: TransactionContext,
  locale: string
): Promise<SectionCandidates> {
  const all: Section[] = [];
  for (let after: string | null = null; ;) {
    const page = await ctx.sections.list(after, MAX_PAGE_SIZE);
    all.push(...page.rows);
    if (!page.next) break;
    after = page.next;
  }
  return sectionCandidates(all, locale);
}

/**
 * The token a section suggestion stores in place of a block id: a hash of the offered ids and
 * titles, so the worker and acceptance see a renamed, added or removed section as a stale request
 * without the row keeping a copy of the titles. The lead needs no hash: the base revision pins it.
 */
export async function sectionToken(candidates: readonly SectionCandidate[]): Promise<string> {
  return `section:${await sha256Hex(JSON.stringify(candidates.map((c) => [c.id, c.title])))}`;
}

/** The one text part that lists the candidates: a JSON array of id and title. */
export const sectionChoices = (candidates: readonly SectionCandidate[]): string =>
  JSON.stringify(candidates.map((c) => ({ id: c.id, title: c.title })));
