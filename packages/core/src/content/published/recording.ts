// The recording on a card (MY-304, the card MY-305 PR 1 left): an article with the media profile
// whose card projection names a video (`mediaRecording`) shows a play mark and the recording's
// length wherever the shared card stands, in an overview, a dossier box, "Read more" and on an
// author's page. The length is the video's own (`durationSeconds`), not stored on the revision, so
// a card reads it with the row; null when the profile hides it or the provider has not reported
// one. A trashed or missing video gives no mark, as the article's header then has no recording.
// A restricted article's card is its teaser, which has no blocks, so it never shows one.
//
// Rejected: copying the duration into the document at save (a second truth beside the video, stale
// after a re-encode) and resolving it in the web renderer (the read route and MCP would differ).

import { z } from 'zod';
import type { TransactionContext } from '../../ports.js';
import { cardDocument } from '../access/projection.js';
import { mediaRecording } from '../header/article-profile.js';
import type { ContentDocument } from '../model.js';

export const CardRecording = z
  .object({
    /** The recording's length in seconds; null when hidden or not known yet. */
    seconds: z.number().nonnegative().nullable(),
  })
  .strict();
export type CardRecording = z.infer<typeof CardRecording>;

/** Video id to length for the recordings these documents' cards name; trashed videos left out. */
export type CardRecordings = ReadonlyMap<string, number | null>;

export const NO_RECORDINGS: CardRecordings = new Map();

/** Read once per list, with the rows: one video read per distinct recording. */
export async function cardRecordings(
  ctx: TransactionContext,
  documents: readonly ContentDocument[]
): Promise<CardRecordings> {
  const ids = new Set<string>();
  for (const doc of documents) {
    const block = mediaRecording(cardDocument(doc));
    if (block) ids.add(block.props.videoId);
  }
  const found = new Map<string, number | null>();
  for (const id of ids) {
    const video = await ctx.videos.get(id);
    if (video && !video.trashedAt) found.set(id, video.durationSeconds);
  }
  return found;
}

/** The recording a card of `card` (already its card projection) shows, or undefined. */
export function cardRecording(
  card: ContentDocument,
  recordings: CardRecordings
): CardRecording | undefined {
  const block = mediaRecording(card);
  if (!block || !recordings.has(block.props.videoId)) return undefined;
  return { seconds: block.duration ? (recordings.get(block.props.videoId) ?? null) : null };
}
