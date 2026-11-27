// The dossier boxes of a public item as the page renders them (MY-260): what core read with the
// item (`PublishedItem.dossiers`, only dossiers published in this locale and public members),
// turned into site-root paths and dates in the locale, the way an overview in list form shows
// its entries. Part of the page's ETag digest, so a new member or a renamed dossier is a new tag.
// Apart from `resolve.ts`, which stands at its size ceiling, and apart from the blocks, because a
// box is not a block of the document: the editor switches it off with `showDossier`, never moves it.

import { contentPath, type PublishedItem } from '@mycel/core';
import { overviewWhen } from '../../../blocks/resolve.js';
import { ui } from '../../../../i18n/index.js';

export interface RenderDossier {
  id: string;
  /** The dossier page's site-root path in this locale. */
  href: string;
  title: string;
  lead: string | null;
  /** Its published revision, so the digest moves when the dossier is republished. */
  revisionId: string;
  members: {
    id: string;
    href: string;
    title: string;
    date: { iso: string; label: string };
    revisionId: string;
  }[];
}

export interface RenderDossiers {
  /** "Part of the dossier", above each dossier's title. */
  partOf: string;
  boxes: RenderDossier[];
}

/** Null when the item shows no box. */
export function renderDossiers(
  item: Pick<PublishedItem, 'dossiers'>,
  locale: string,
  defaultLocale: string,
  timeZone: string
): RenderDossiers | null {
  if (!item.dossiers?.length) return null;
  const t = ui(locale);
  return {
    partOf: t('public.dossier.partOf'),
    boxes: item.dossiers.map((d) => ({
      id: d.id,
      href: contentPath({ type: 'page', slug: d.slug }, locale, defaultLocale),
      title: d.title,
      lead: d.lead,
      revisionId: d.revisionId,
      members: d.members.map((m) => ({
        id: m.id,
        href: contentPath(m, locale, defaultLocale),
        title: m.title,
        date: overviewWhen(m, locale, timeZone).date,
        revisionId: m.revisionId,
      })),
    })),
  };
}
