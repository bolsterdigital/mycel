// What the media picker (brief media-picker, TODO #66) needs from the server: an image as a
// choice (id, name, whether a thumbnail exists) and one upload of one file with the refusal as
// catalog copy. The media page's upload action and the picker's JSON route share `uploadFile`,
// so a file is refused in the same words in both places. Rejected: a second copy of the issue
// map in the picker route, which would drift from the media page's.
import {
  MAX_UPLOAD_BYTES,
  UseCaseError,
  useCases,
  type MediaCredit,
  type Principal,
} from '@mycel/core';
import { failureOf } from './admin-actions.js';
import { runtime } from '../runtime.js';
import type { UiKey } from '../../../i18n/index.js';
import type { MediaChoice } from '../../admin/media-choice.js';

/** Core's i18n key of a refused upload, mapped to the admin's copy. */
const UPLOAD_ISSUES: Record<string, UiKey> = {
  'media.type.svg': 'admin.media.error.svg',
  'media.type.unsupported': 'admin.media.error.type',
  'media.type.mismatch': 'admin.media.error.mismatch',
  'media.type.unreadable': 'admin.media.error.unreadable',
  'media.pixels.too-many': 'admin.media.error.pixels',
  'media.size.too-large': 'admin.media.error.tooLarge',
  'media.bytes.empty': 'admin.media.error.noFile',
  'media.filename.empty': 'admin.media.error.noFile',
  'media.filename.too-long': 'admin.media.error.filename',
  'media.filename.invalid': 'admin.media.error.filename',
};

/** The card of a block shows an image about this wide; the next wider variant is enough. */
const CARD_WIDTH = 640;

export const mediaChoice = (m: {
  id: string;
  filename: string;
  variants: readonly { name: string; format: string; width: number | null }[];
  width?: number | null;
  height?: number | null;
  caption?: Record<string, string>;
  credit?: MediaCredit;
}): MediaChoice => {
  const widths = m.variants
    .filter((v) => v.format === 'webp' && /^w\d+$/.test(v.name) && v.width !== null)
    .sort((a, b) => a.width! - b.width!);
  const variant = widths.find((v) => v.width! >= CARD_WIDTH) ?? widths.at(-1);
  return {
    id: m.id,
    label: m.filename,
    thumb: m.variants.some((v) => v.name === 'thumb'),
    card:
      variant && m.width && m.height && m.caption && m.credit
        ? {
            file: `${variant.name}.webp`,
            width: m.width,
            height: m.height,
            caption: m.caption,
            credit: m.credit,
          }
        : null,
  };
};

export type Uploaded =
  | { ok: true; choice: MediaChoice }
  | { ok: false; status: number; filename: string; error: UiKey; what?: UiKey | undefined };

/** Upload one posted file as the operator; a refusal comes back as copy, never as a throw. */
export async function uploadFile(
  principal: Principal,
  file: File,
  access: 'public' | 'restricted'
): Promise<Uploaded> {
  const refused = (status: number, error: UiKey, what?: UiKey) =>
    ({ ok: false, status, filename: file.name, error, what }) as const;
  if (file.size === 0) return refused(400, 'admin.media.error.noFile');
  if (file.size > MAX_UPLOAD_BYTES) return refused(400, 'admin.media.error.tooLarge');
  try {
    const m = await runtime().invoker.run(useCases.uploadMedia, principal, {
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      bytes: Buffer.from(await file.arrayBuffer()).toString('base64'),
      access,
    });
    return { ok: true, choice: mediaChoice(m) };
  } catch (e) {
    if (!(e instanceof UseCaseError)) throw e;
    const { status, body } = failureOf(e, 'upload', {
      conflict: 'admin.error.invalid',
      invalid: 'admin.media.error.invalid',
      issues: UPLOAD_ISSUES,
    });
    return refused(status, body.error, body.what);
  }
}
