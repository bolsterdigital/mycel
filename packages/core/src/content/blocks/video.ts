// Blocks hold a local record id, so revisions and translations can reuse the same recording.
import { z } from 'zod';
import { localized } from '../../i18n/locale.js';
import type { BlockDefinition } from '../block-types.js';
import { EXAMPLE_IDS } from './example-ids.js';

const props = z
  .object({
    videoId: z.string().guid(),
    caption: localized(z.string().max(2000)).optional(),
  })
  .strict();

export const videoDefinition: BlockDefinition<typeof props, 1> = {
  version: 1,
  variants: {},
  props,
  fields: [
    { key: 'videoId', kind: 'reference', to: 'video' },
    { key: 'caption', kind: 'text', localized: true, multiline: true, optional: 'omit' },
  ],
  localized: (p) => (p.caption ? [{ path: ['caption'], value: p.caption, required: false }] : []),
  references: (p) => [{ type: 'video', refId: p.videoId }],
  examples: [
    {
      name: 'video-shared',
      props: {
        videoId: EXAMPLE_IDS.video,
        caption: { en: 'Along the river.', nl: 'Langs de rivier.' },
      },
    },
  ],
};
