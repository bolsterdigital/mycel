// Both native neighbour moves and enhanced anchor moves use the revisioned move's placement.
// This adapter translates form controls only; the use case validates ids, conflicts and scope.
import type { ContentDocument } from '@mycel/core';
export function blockMovePlace(
  direction: string | undefined,
  anchor: string | undefined,
  blocks: ContentDocument['blocks'],
  index: number
): { before: string } | { after: string } | undefined {
  if ((direction === 'before' || direction === 'after') && anchor)
    return direction === 'before' ? { before: anchor } : { after: anchor };
  const up = direction === 'up';
  const neighbour = blocks[up ? index - 1 : index + 1];
  return neighbour ? (up ? { before: neighbour.id } : { after: neighbour.id }) : undefined;
}
