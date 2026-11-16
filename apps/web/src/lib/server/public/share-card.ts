// A generated share card: only the current card of a published, public locale. The
// fingerprint in the file name must be the one `content.share_card.get` gives now, so an older
// card, a card of an unpublished locale or a guessed name is a 404, and the private bucket never
// gets an address of its own. A current card never changes under its name: immutable.
// Rejected: serving whatever the key holds (a withdrawn item's card would stay reachable).
import { anonymousPrincipal, isUuid, shareCardKey, UseCaseError, useCases } from '@mycel/core';
import { refuse } from '../http/refuse.js';
import { shareable } from '../http/security-headers.js';
import { runtime } from '../runtime.js';
import { siteTenant, type Site } from '../site.js';

export async function shareCardResponse(
  site: Site,
  params: { itemId: string; locale: string; file: string }
): Promise<Response> {
  const fingerprint = /^([0-9a-f]{24})\.png$/.exec(params.file)?.[1];
  if (!fingerprint || !isUuid(params.itemId)) refuse(404);
  const tenant = siteTenant(site);
  let card;
  try {
    ({ card } = await runtime().invoker.run(
      useCases.getShareCard,
      anonymousPrincipal(tenant, ['content:read']),
      { itemId: params.itemId, locale: params.locale }
    ));
  } catch (e) {
    // An unknown item or a malformed locale says no more than a card that is not there.
    if (e instanceof UseCaseError && (e.code === 'not_found' || e.code === 'invalid_input'))
      refuse(404);
    throw e;
  }
  if (card?.fingerprint !== fingerprint) refuse(404);
  const bytes = await runtime().blobs.get(
    shareCardKey(tenant.id, params.itemId, params.locale, fingerprint)
  );
  if (!bytes) refuse(404);
  return shareable(
    new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'image/png',
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    })
  );
}
