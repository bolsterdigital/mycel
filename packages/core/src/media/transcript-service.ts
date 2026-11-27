// Publication copies exactly the draft the editor reviewed. The version also rejects a stale
// save when two editors work in the same language, while other languages stay independent.
// Chapters (MY-305) travel with the transcript of their language: saved in the same draft, part
// of the same version and published by the same action, so a reviewed pair goes live together.
// Rejected: their own use cases, which would let chapters go live beside an unreviewed text.
import { z } from 'zod';
import { UseCaseError, notFound } from '../errors.js';
import { Locale } from '../i18n/locale.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import {
  chapterLines,
  importChapters,
  importTranscript,
  MAX_CHAPTERS_SOURCE,
  MAX_TRANSCRIPT,
} from './transcript.js';

const target = z.object({ id: z.string().guid(), locale: Locale }).strict();
const example = { id: '44444444-4444-4444-8444-444444444444', locale: 'en' };
const output = z.object({
  source: z.string(),
  /** The chapters as editable lines, `3:10 Title`; empty when there are none. */
  chapters: z.string(),
  version: z.string(),
  published: z.boolean(),
});

async function read(ctx: TransactionContext, id: string, locale: string) {
  const video = await ctx.videos.get(id);
  if (!video || video.trashedAt) throw notFound('video', id);
  const live = video.publishedTracks[locale] ?? '';
  const source = video.draftTracks?.[locale] ?? live;
  const liveChapters = video.publishedChapters?.[locale] ?? '';
  const chapters = video.draftChapters?.[locale] ?? liveChapters;
  // Without chapters the version is the hash of the transcript alone.
  const version = await ctx.inputHasher.hash(
    chapters ? `${source}\n\0chapters\n${chapters}` : source
  );
  const published = !!live && source === live && chapters === liveChapters;
  return {
    video,
    chapters,
    state: { source, chapters: chapterLines(chapters), version, published },
  };
}

export const getTranscript = defineUseCase({
  name: 'media.transcript.get',
  kind: 'query',
  requires: 'media:write',
  description: 'Read the editable transcript for one recording and language.',
  input: target,
  output,
  examples: [{ input: example }],
  async handler(ctx, { id, locale }) {
    return (await read(ctx, id, locale)).state;
  },
});

const base = target.extend({ version: z.string().max(200) });
const check = (current: string, version: string) => {
  if (current !== version) throw new UseCaseError('conflict', 'The transcript has changed');
};

export const saveTranscript = defineUseCase({
  name: 'media.transcript.update',
  kind: 'command',
  requires: 'media:write',
  description:
    'Import or edit a draft in WebVTT, SRT or timestamped plain text, with chapters as `3:10 Title` lines (empty clears them; left out keeps them).',
  input: base.extend({
    source: z.string().min(1).max(MAX_TRANSCRIPT),
    chapters: z.string().max(MAX_CHAPTERS_SOURCE).optional(),
  }),
  output,
  examples: [{ input: { ...example, version: 'version', source: '00:00 Along the river.' } }],
  async handler(ctx, { id, locale, source, chapters, version }) {
    await ctx.media.lock();
    const { video, state } = await read(ctx, id, locale);
    check(state.version, version);
    const track = importTranscript(source, video.durationSeconds);
    await ctx.videos.update(id, {
      draftTracks: { ...video.draftTracks, [locale]: track },
      ...(chapters === undefined
        ? {}
        : {
            draftChapters: {
              ...video.draftChapters,
              [locale]: importChapters(chapters, video.durationSeconds),
            },
          }),
    });
    return (await read(ctx, id, locale)).state;
  },
});

export const publishTranscript = defineUseCase({
  name: 'media.transcript.publish',
  kind: 'command',
  requires: 'content:publish',
  alsoRequires: ['media:write'],
  effect: 'publish',
  description:
    'Publish the reviewed transcript for one language as captions and searchable text, with its chapters.',
  input: base,
  output,
  examples: [{ input: { ...example, version: 'version' } }],
  async handler(ctx, { id, locale, version }) {
    await ctx.media.lock();
    const { video, state, chapters } = await read(ctx, id, locale);
    check(state.version, version);
    if (!state.source) throw new UseCaseError('conflict', 'No transcript to publish');
    await ctx.videos.update(id, {
      publishedTracks: { ...video.publishedTracks, [locale]: state.source },
      publishedChapters: { ...video.publishedChapters, [locale]: chapters },
    });
    return { ...state, published: true };
  },
});
