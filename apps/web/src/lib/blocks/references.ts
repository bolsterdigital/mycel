// Resolve only references the public renderer uses. The full registry also records references
// used for validation and media credits, which the resolver fetches through their own read paths.
import { linkedItemIds, type Block } from '@mycel/core';

/** The references the resolver needs; rich-text links are read from the projected locale only. */
export function referencesOf(b: Block): { type: 'media' | 'form' | 'item'; refId: string }[] {
  const docs = (m: Partial<Record<string, Parameters<typeof linkedItemIds>[0]>> | undefined) =>
    Object.values(m ?? {}).flatMap((d) =>
      d ? linkedItemIds(d).map((refId) => ({ type: 'item' as const, refId })) : []
    );
  const targets = (list: readonly { target: { kind: string; itemId?: string } }[]) =>
    list.flatMap((a) =>
      a.target.kind === 'item' && a.target.itemId
        ? [{ type: 'item' as const, refId: a.target.itemId }]
        : []
    );
  switch (b.type) {
    case 'image':
      return [{ type: 'media', refId: b.props.mediaId }];
    case 'hero':
      return [
        ...(b.props.image ? [{ type: 'media' as const, refId: b.props.image.mediaId }] : []),
        ...targets(b.props.actions),
      ];
    case 'cta':
      return targets(b.props.actions);
    case 'cards':
      return b.props.cards.flatMap((c) => targets(c.actions));
    case 'file-download':
      return b.props.files.map((f) => ({ type: 'media' as const, refId: f.fileId }));
    case 'audio':
      return [{ type: 'media' as const, refId: b.props.fileId }];
    case 'video-embed':
      return [
        ...(b.props.poster ? [{ type: 'media' as const, refId: b.props.poster.mediaId }] : []),
        ...(b.props.videoPageId ? [{ type: 'item' as const, refId: b.props.videoPageId }] : []),
      ];
    case 'gallery':
      return b.props.images.map((i) => ({ type: 'media' as const, refId: i.mediaId }));
    case 'timeline':
      return b.props.events.flatMap((e) => targets(e.actions));
    case 'form':
    case 'signup-form':
      return [{ type: 'form', refId: b.props.formId }];
    case 'rich-text':
      return docs(b.props.content);
    case 'callout':
      return docs(b.props.body);
    case 'faq':
      return b.props.entries.flatMap((e) => docs(e.answer));
    default:
      return [];
  }
}
