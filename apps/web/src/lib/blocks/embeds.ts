// Which video providers the public page may turn into a player (docs/reference/integrations.md,
// #41 PR 2). The route decides once per response with core's `integrationDecision` and sets the
// list here; `VideoEmbed` reads it. Anything rendered without it, the live draft, an e-mail or a
// test, gets an empty list and keeps the plain link, so no preview loads a third party.
// Rejected: a prop through `Blocks` and `Prefooter`, which would thread one page fact through every
// block list for one block type; and a field on the render model, which is the same in every
// representation while the placement belongs to the public page alone.

import { getContext, setContext } from 'svelte';
import type { EmbedId } from '@mycel/core';

const KEY = Symbol('mycel.embeds');

/** Called by the public page with the embeds its decision placed. */
export function placeEmbeds(embeds: readonly EmbedId[]): void {
  setContext(KEY, embeds);
}

/** The embeds the page placed; empty outside a public page. */
export function placedEmbeds(): readonly EmbedId[] {
  return getContext<readonly EmbedId[] | undefined>(KEY) ?? [];
}
