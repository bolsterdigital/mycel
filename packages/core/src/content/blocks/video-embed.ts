// Parse provider-specific identifiers before the player URL is built. A video block stores an
// identifier, so an editor cannot supply a frame origin or HTML.
import { z } from 'zod';
import { localized } from '../../i18n/locale.js';
import { BUNNY_STREAM_VIDEO_ID, EMBED_IDS } from '../../integrations/model.js';
import { EXAMPLE_IDS } from './example-ids.js';
import { imageRefs } from './image-references.js';
import type { BlockDefinition, BlockField, WIDTHS } from '../block-types.js';

const youtubeId = /^[A-Za-z0-9_-]{11}$/;
const creditLabel = z.string().trim().min(1).max(240);
const creditUrl = z
  .string()
  .max(2048)
  .url()
  .regex(/^https?:\/\//i);

type PosterImage = {
  mediaId: string;
  decorative: boolean;
  alt: Partial<Record<string, string>> | null;
};

export function videoEmbedDefinition(
  widths: typeof WIDTHS,
  poster: z.ZodType<PosterImage, PosterImage>,
  posterFields: readonly BlockField[]
) {
  const props = z
    .object({
      provider: z.enum(EMBED_IDS),
      videoId: z.string().min(1).max(56),
      title: localized(z.string().min(1).max(200)),
      caption: localized(z.string().max(2000)).optional(),
      poster: poster.optional(),
      durationSeconds: z
        .string()
        .regex(/^[1-9][0-9]{0,5}$/)
        .optional(),
      maker: creditLabel.optional(),
      makerUrl: creditUrl.optional(),
      licenceLabel: creditLabel.optional(),
      licenceUrl: creditUrl.optional(),
      youtubeWatchId: z.string().regex(youtubeId).optional(),
      videoPageId: z.string().uuid().optional(),
      width: z.enum(widths).default('content'),
    })
    .strict()
    .refine(
      (p) =>
        p.provider === 'youtube'
          ? youtubeId.test(p.videoId)
          : p.provider === 'vimeo'
            ? /^[0-9]{1,20}$/.test(p.videoId)
            : BUNNY_STREAM_VIDEO_ID.test(p.videoId),
      { path: ['videoId'], message: 'content.video.id-invalid' }
    );
  const definition: BlockDefinition<typeof props, 1> = {
    version: 1,
    props,
    fields: [
      { key: 'provider', kind: 'choice', options: EMBED_IDS },
      { key: 'videoId', kind: 'text', localized: false },
      { key: 'title', kind: 'text', localized: true },
      { key: 'caption', kind: 'text', localized: true, multiline: true, optional: 'omit' },
      { key: 'poster', kind: 'group', optional: 'omit', fields: posterFields },
      { key: 'durationSeconds', kind: 'text', localized: false, optional: 'omit' },
      { key: 'maker', kind: 'text', localized: false, optional: 'omit' },
      { key: 'makerUrl', kind: 'text', localized: false, optional: 'omit' },
      { key: 'licenceLabel', kind: 'text', localized: false, optional: 'omit' },
      { key: 'licenceUrl', kind: 'text', localized: false, optional: 'omit' },
      { key: 'youtubeWatchId', kind: 'text', localized: false, optional: 'omit' },
      { key: 'videoPageId', kind: 'reference', to: 'item', optional: 'omit' },
      { key: 'width', kind: 'choice', options: widths },
    ],
    variants: { provider: EMBED_IDS, width: widths },
    localized: (p) => [
      { path: ['title'], value: p.title, required: true },
      ...(p.caption ? [{ path: ['caption'], value: p.caption, required: true }] : []),
      ...(p.poster?.alt ? [{ path: ['poster', 'alt'], value: p.poster.alt, required: true }] : []),
    ],
    references: (p) => [
      ...(p.poster ? imageRefs(p.poster) : []),
      ...(p.videoPageId ? [{ type: 'item' as const, refId: p.videoPageId }] : []),
    ],
    examples: [
      {
        name: 'video-youtube',
        props: {
          provider: 'youtube',
          videoId: 'dQw4w9WgXcQ',
          title: { nl: 'Verslag van de mars', en: 'Report of the march' },
        },
      },
      {
        name: 'video-vimeo-wide',
        props: {
          provider: 'vimeo',
          videoId: '76979871',
          title: { nl: 'Interview met de wethouder', en: 'Interview with the alderman' },
          caption: { nl: 'Opgenomen in maart.', en: 'Recorded in March.' },
          width: 'wide',
        },
      },
      {
        name: 'video-bunny-stream',
        props: {
          provider: 'bunny-stream',
          videoId: '12345/12345678-abcd-4321-9876-0123456789ab',
          title: { nl: 'Een rivierotter op jacht', en: 'A river otter hunting' },
          caption: {
            nl: 'Een rivierotter zoekt rivierkreeft.',
            en: 'A river otter hunts crayfish.',
          },
          poster: { mediaId: EXAMPLE_IDS.image, decorative: true, alt: null },
          durationSeconds: '54',
          maker: 'Tom Koerner / U.S. Fish and Wildlife Service',
          makerUrl: 'https://example.org/maker',
          licenceLabel: 'CC BY 2.0',
          licenceUrl: 'https://creativecommons.org/licenses/by/2.0/',
          youtubeWatchId: 'aqz-KE-bpKQ',
        },
      },
      {
        name: 'video-full',
        props: {
          provider: 'youtube',
          videoId: 'aqz-KE-bpKQ',
          title: { nl: 'Korte film', en: 'Short film' },
          width: 'full',
        },
      },
    ],
  };
  return definition;
}
