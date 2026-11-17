// The two projections of a restricted item (ADR 016 rule 3, ADR 018 rules 6 and 7): the whole
// document for a reader with access, and the teaser document for everyone else. The decision is
// made here, once, on the pinned revision, before a locale is projected, a reference is resolved
// or anything is serialised; `content.published.get` returns what this module hands it, so HTML,
// JSON, Markdown and every later representation get the same answer and no front decides.
//
// The teaser document is a document: the same shape with the body cut, so every derivation that
// follows (the description chain in header/effective.ts, the block projection, the references a
// front resolves) can only reach what a visitor may see. It keeps the document header (title,
// lead, hero image) and the explicit search and card fields, which the editor wrote to be shown;
// it drops the blocks behind the boundary, an article's corrections (they quote the body) and an
// event's when and where (the place or the link is what a members' meeting restricts).
//
// The reader is the principal's: a `reader` actor names a session row, and the supporter and
// their grants are read from that row and the live projection now (ADR 019 rule 5). An operator,
// a key, an agent and a visitor are nobody here; an operator reads a restricted body through
// `content.item.get`, which asks for a membership.
//
// Rejected: a flag on the full projection that the renderer honours (the body would be in the
// JSON and one forgetful representation leaks it), cutting the projected blocks after the locale
// (the description chain would already have read the body), and a prompt per tier name here (the
// copy of a prompt is the front's; the code says which of the two it is).

import { z } from 'zod';
import type { TransactionContext } from '../../ports.js';
import { liveSession } from '../../readers/service.js';
import '../../supporters/ports.js';
import type { ContentDocument } from '../model.js';
import { hasAccess, readerOf, type ReaderAccess } from './model.js';

/**
 * Why the body was left out, as the one thing a visitor can do about it: `signin` for nobody
 * signed in, `tier` for a reader whose grants do not open this item.
 */
export const AccessGate = z.object({ prompt: z.enum(['signin', 'tier']) });
export type AccessGate = z.infer<typeof AccessGate>;

/**
 * The blocks in front of the teaser boundary (ADR 018 rule 6): none for `lead`, those above the
 * one top-level `paywall` block for `marker`, the first `n` for `{ blocks: n }`. A marker teaser
 * without its boundary shows nothing: a stored document cannot be one (`accessIssues`), and an
 * unreadable teaser is a closed one.
 */
export function teaserBlocks(
  doc: Pick<ContentDocument, 'access' | 'blocks'>
): ContentDocument['blocks'] {
  const { teaser } = doc.access;
  if (teaser === 'lead') return [];
  if (teaser === 'marker') {
    const boundary = doc.blocks.findIndex((b) => b.type === 'paywall');
    return boundary < 0 ? [] : doc.blocks.slice(0, boundary);
  }
  return doc.blocks.slice(0, Math.max(0, teaser.blocks));
}

/** The document a visitor without access is served; see the comment at the top. */
export function teaserDocument(doc: ContentDocument): ContentDocument {
  const blocks = teaserBlocks(doc);
  if (doc.type === 'article') return { ...doc, blocks, corrections: [] };
  const { event: _event, ...page } = doc;
  return { ...page, blocks };
}

/** The reader behind this request's principal, read now; null for everyone who is not one. */
export async function readerAccess(ctx: TransactionContext): Promise<ReaderAccess | null> {
  const { actor } = ctx.principal;
  if (actor.kind !== 'reader') return null;
  const session = await liveSession(ctx, actor.sessionId, ctx.clock.now());
  if (!session) return null;
  return readerOf(await ctx.supporters.getProjectionById(session.supporterId));
}

/**
 * The document this request's principal may read of a published revision, and the gate when the
 * body was cut. A public document is returned as it is without reading any session.
 */
export async function accessProjection(
  ctx: TransactionContext,
  doc: ContentDocument
): Promise<{ document: ContentDocument; gate: AccessGate | null }> {
  if (doc.access.level === 'public') return { document: doc, gate: null };
  const reader = await readerAccess(ctx);
  if (hasAccess(reader, doc, ctx.clock.now())) return { document: doc, gate: null };
  return { document: teaserDocument(doc), gate: { prompt: reader ? 'tier' : 'signin' } };
}
