// The default `MediaDelivery`: variants are served by the site itself at `/media/<id>/<file>`
// (apps/web, `(public)/[tenant]/media/[id]/[variant]/+server.ts`), so a variant lives on the
// tenant's own domain, its cache headers follow from an immutable key, and a restricted asset is
// one signature check away. No I/O: a path is a string, the signature is the core's `Signer`.
//
// A signed path carries `exp` (unix seconds) and `sig`, a token over `media:<id>:<file>:<exp>`.
// The media id is globally unique and the route reads the row under the visited site's tenant,
// so a signature for one site's asset opens nothing on another site. Rejected: a signature over
// the full URL (the same asset is reachable on several hostnames of one tenant).

import type { Signer } from '../ports.js';
import type { MediaDelivery } from './ports.js';

const payload = (mediaId: string, file: string, exp: number) => `media:${mediaId}:${file}:${exp}`;

export const appDelivery: MediaDelivery = {
  variantPath: (mediaId, file) => `/media/${mediaId}/${file}`,
  async signedVariantPath(signer, mediaId, file, expiresAt) {
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sig = await signer.sign(payload(mediaId, file, exp));
    return `/media/${mediaId}/${file}?exp=${exp}&sig=${encodeURIComponent(sig)}`;
  },
};

/** True when `exp` and `sig` (from a signed path) open `file` of `mediaId` at `now`. */
export async function verifyMediaSignature(
  signer: Signer,
  mediaId: string,
  file: string,
  exp: string | null,
  sig: string | null,
  now: Date
): Promise<boolean> {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) * 1000 <= now.getTime()) return false;
  return (await signer.verify(sig)) === payload(mediaId, file, Number(exp));
}
