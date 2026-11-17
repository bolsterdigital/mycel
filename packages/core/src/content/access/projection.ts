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
// Restricted media (ADR 018 rule 7) open the same way: a reader with access gets the item's own
// restricted images and files, those of its blocks and its hero, as views with paths signed for
// this tenant, item and locale until the earliest of ten minutes, the session's end and the end
// of the grants that open it. Everyone else gets none, and a card, feed or share card never asks.
//
// Rejected: a flag on the full projection that the renderer honours (the body would be in the
// JSON and one forgetful representation leaks it), cutting the projected blocks after the locale
// (the description chain would already have read the body), and a prompt per tier name here (the
// copy of a prompt is the front's; the code says which of the two it is).

import { z } from 'zod';
import type { TransactionContext } from '../../ports.js';
import { variantFile, type MediaView } from '../../media/model.js';
import '../../media/ports.js';
import { toMediaView } from '../../media/service.js';
import { readerMediaScope } from '../../media/signed-paths.js';
import { liveSession } from '../../readers/service.js';
import '../../supporters/ports.js';
import { blockReferenceRows } from '../blocks.js';
import type { ContentDocument } from '../model.js';
import { accessEndsAt, hasAccess, readerOf, type ReaderAccess } from './model.js';

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

/**
 * What a card, a feed entry, a menu label or a share card of a published document may draw from:
 * the document when it is public, else its teaser without any block (title, lead, header image
 * and the explicit card and search fields). It does not depend on who reads: a card shows a
 * reader with access no more than anyone else (ADR 018 rule 7); access opens the body only at the
 * item's own address. So a summary never falls back to a paragraph behind or before the boundary.
 */
export function cardDocument(doc: ContentDocument): ContentDocument {
  return doc.access.level === 'public' ? doc : { ...teaserDocument(doc), blocks: [] };
}

/**
 * The reader behind this request's principal, read now, with the end of their session; null for
 * everyone who is not one.
 */
export async function readerAccess(
  ctx: TransactionContext
): Promise<(ReaderAccess & { sessionEndsAt: Date }) | null> {
  const { actor } = ctx.principal;
  if (actor.kind !== 'reader') return null;
  const session = await liveSession(ctx, actor.sessionId, ctx.clock.now());
  if (!session) return null;
  const reader = readerOf(await ctx.supporters.getProjectionById(session.supporterId));
  return reader && { ...reader, sessionEndsAt: session.expiresAt };
}

/**
 * The document this request's principal may read of a published revision, and the gate when the
 * body was cut. A public document is returned as it is without reading any session. `until` is
 * when a reader's access to a restricted document ends (session or grants); null otherwise.
 */
export async function accessProjection(
  ctx: TransactionContext,
  doc: ContentDocument
): Promise<{ document: ContentDocument; gate: AccessGate | null; until: Date | null }> {
  if (doc.access.level === 'public') return { document: doc, gate: null, until: null };
  const reader = await readerAccess(ctx);
  const now = ctx.clock.now();
  if (reader && hasAccess(reader, doc, now)) {
    const grants = accessEndsAt(reader, doc, now);
    const until = grants && grants < reader.sessionEndsAt ? grants : reader.sessionEndsAt;
    return { document: doc, gate: null, until };
  }
  return {
    document: teaserDocument(doc),
    gate: { prompt: reader ? 'tier' : 'signin' },
    until: null,
  };
}

/** How long a reader's signed media path works at most (ADR 018 rule 7). */
export const READER_MEDIA_TTL_MS = 10 * 60 * 1000;

/**
 * The restricted media of a document a reader may read until `until`, by id, as views whose paths
 * are signed for `scope` (tenant, item, locale): those of its blocks and its hero, ready and not
 * deleted. Public media are left out, the front reads them as a visitor; so are the featured and
 * share images, which only cards and share cards show.
 */
export async function readerMedia(
  ctx: TransactionContext,
  doc: Pick<ContentDocument, 'blocks' | 'heroImageId'>,
  scope: { itemId: string; locale: string },
  until: Date
): Promise<Record<string, MediaView>> {
  const ids = new Set(
    blockReferenceRows(doc.blocks)
      .filter((r) => r.type === 'media')
      .map((r) => r.refId)
  );
  if (doc.heroImageId) ids.add(doc.heroImageId);
  const ttl = new Date(ctx.clock.now().getTime() + READER_MEDIA_TTL_MS);
  const expiresAt = until < ttl ? until : ttl;
  const signedFor = readerMediaScope(ctx.principal.tenantId, scope.itemId, scope.locale);
  const out: Record<string, MediaView> = {};
  for (const id of ids) {
    const m = await ctx.media.get(id);
    if (!m || m.deletedAt || m.state !== 'ready' || m.access !== 'restricted') continue;
    const view = toMediaView(ctx, m);
    const paths = await Promise.all(
      m.variants.map((v) =>
        ctx.delivery.signedVariantPath(ctx.signer, m.id, variantFile(v), expiresAt, signedFor)
      )
    );
    out[id] = { ...view, variants: view.variants.map((v, i) => ({ ...v, path: paths[i]! })) };
  }
  return out;
}
