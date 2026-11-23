// Parse provider-specific identifiers before the player URL is built. A video block stores an
// identifier, so an editor cannot supply a frame origin or HTML.
import { z } from 'zod';
import { localized } from '../../i18n/locale.js';
import { BUNNY_STREAM_VIDEO_ID, EMBED_IDS } from '../../integrations/model.js';
import type { BlockDefinition, WIDTHS } from '../block-types.js';

export function videoEmbedDefinition(widths: typeof WIDTHS) {
  const props = z
    .object({
      provider: z.enum(EMBED_IDS),
      videoId: z.string().min(1).max(56),
      title: localized(z.string().min(1).max(200)),
      caption: localized(z.string().max(2000)).optional(),
      width: z.enum(widths).default('content'),
    })
    .strict()
    .refine(
      (p) =>
        p.provider === 'youtube'
          ? /^[A-Za-z0-9_-]{11}$/.test(p.videoId)
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
      { key: 'width', kind: 'choice', options: widths },
    ],
    variants: { provider: EMBED_IDS, width: widths },
    localized: (p) => [
      { path: ['title'], value: p.title, required: true },
      ...(p.caption ? [{ path: ['caption'], value: p.caption, required: true }] : []),
    ],
    references: () => [],
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
