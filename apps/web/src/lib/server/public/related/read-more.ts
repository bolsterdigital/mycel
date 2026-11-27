// "Read more" under a public article (MY-304) as the page renders it: what core read with the
// item (`PublishedItem.readMore`), turned into site-root paths, dates in the locale and the card
// image, for the same card the news overview and the author profile show (`ArticleCard`). Part of
// the page's ETag digest, so a newly published article in the section is a new tag.
// Apart from `resolve.ts`, which stands at its size ceiling, and apart from the blocks, because the
// row is not a block of the document: the site switches it off, the editor never places it.
// The image resolves as on the author profile (`person-page.ts`): decorative, since the title
// beside it is the card's one link and names it.

import { contentPath, type PublishedItem } from '@mycel/core';
import { overviewWhen, resolveIntro, type ResolveSource } from '../../../blocks/resolve.js';
import type { RenderCardRecording, RenderImage } from '../../../blocks/model.js';
import { cardRecording } from '../../../blocks/recording.js';
import { ui } from '../../../../i18n/index.js';

export interface RenderReadMore {
  /** "Read more", the row's heading. */
  title: string;
  /** "Members only", on the card of a restricted article. */
  restricted: string;
  cards: {
    id: string;
    href: string;
    title: string;
    summary: string | null;
    date: { iso: string; label: string };
    image: RenderImage | null;
    restricted: boolean;
    /** A Video/audio article's recording (play mark and length); else null. */
    recording: RenderCardRecording | null;
    /** Its published revision, so the digest moves when the article is republished. */
    revisionId: string;
  }[];
}

/** Null when the item shows no row. */
export async function renderReadMore(
  item: Pick<PublishedItem, 'readMore'>,
  source: ResolveSource,
  locale: string,
  defaultLocale: string,
  timeZone: string
): Promise<RenderReadMore | null> {
  if (!item.readMore?.length) return null;
  const t = ui(locale);
  const image = async (entry: NonNullable<PublishedItem['readMore']>[number]) =>
    entry.imageId
      ? (
          await resolveIntro(
            source,
            {
              lead: null,
              heroImageId: entry.imageId,
              heroAlt: null,
              heroPlacement: entry.imagePlacement,
            },
            locale
          )
        ).hero
      : null;
  return {
    title: t('public.readMore.title'),
    restricted: t('block.overview.restricted'),
    cards: await Promise.all(
      item.readMore.map(async (entry) => ({
        id: entry.id,
        href: contentPath(entry, locale, defaultLocale),
        title: entry.title,
        summary: entry.summary,
        date: overviewWhen(entry, locale, timeZone).date,
        image: await image(entry),
        restricted: entry.restricted,
        recording: cardRecording(entry.recording, locale),
        revisionId: entry.revisionId,
      }))
    ),
  };
}
