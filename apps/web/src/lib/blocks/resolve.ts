// The one server-side resolver (brief #8c § 1): from a published projection to the render model,
// fetching every tenant reference the blocks make once, up front. Components never reach the
// database, so the same renderer runs on a preview (#11) and in the conformance suite without
// one.
//
// What a reference turns into is decided here, and it fails closed:
//   - media: `media.get`; a restricted, deleted, failed or non-image asset is null, and the block
//     renders nothing (no figure, no alt, no path). Signed paths for readers are #19.
//   - forms: `forms.form.get` with a fresh `startedToken`, as the probe did; unknown is null.
//   - items: a public path only if the item is published in this locale and its published
//     revision is `access.level: public`, the rules of `content.page.get`; otherwise null, so an
//     action without a target is dropped and a text link becomes text. #8c1 keeps the current
//     grammar (`/<slug>`, pages only); #8c2 adds the locale prefix and `articles/`.
//
// No locks, no writes. Rejected: resolving inside each component (a query per block, and a
// renderer that cannot run without a database), and passing the whole `MediaView` through
// (restricted paths would sit in the model even if no component printed them).

import {
  type FormDefinition,
  type Invoker,
  type MediaView,
  type Principal,
  type UnitOfWork,
  UseCaseError,
  allBlocks,
  linkedItemIds,
  pick,
  statusOf,
  useCases,
  type Block,
  type MediaCredit,
} from '@mycel/core';
import { ui } from '../../i18n/index.js';
import type {
  BlockCopy,
  RenderAction,
  RenderBlock,
  RenderForm,
  RenderImage,
  RenderModel,
} from './model.js';
import { videoUrl } from './model.js';

/** Where the resolver reads tenant data; `runtimeSource` is the real one, tests may stub it. */
export interface ResolveSource {
  form(id: string): Promise<{ form: FormDefinition; startedToken: string } | null>;
  media(id: string): Promise<MediaView | null>;
  itemPath(itemId: string, locale: string): Promise<string | null>;
}

/** The input: one locale of one published revision, already projected by the core. */
export interface Projection {
  locale: string;
  title: string;
  blocks: readonly Block[];
}

const notFound = (e: unknown) => e instanceof UseCaseError && e.code === 'not_found';

/**
 * Reads through the registry where a use case exists (forms, media) and through the unit of work
 * for the item check, which has no public use case of its own. `reader` is the visitor's
 * anonymous principal for the site, with `content:read`, `forms:read` and `media:read`.
 */
export function runtimeSource(deps: {
  invoker: Invoker;
  uow: UnitOfWork;
  reader: Principal;
}): ResolveSource {
  const { invoker, uow, reader } = deps;
  return {
    async form(id) {
      try {
        return await invoker.run(useCases.getForm, reader, { id });
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async media(id) {
      try {
        return await invoker.run(useCases.getMedia, reader, { id });
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    itemPath: (itemId, locale) =>
      uow.run(reader, async (ctx) => {
        const item = await ctx.content.get(itemId);
        if (!item || item.type !== 'page') return null;
        const state = item.publication.find(
          (s) => s.locale === locale && statusOf(s) === 'published'
        );
        if (!state?.publishedRevisionId) return null;
        const revision = await ctx.content.revision(item.id, state.publishedRevisionId);
        if (!revision || revision.document.access.level !== 'public') return null;
        return `/${item.slug}`;
      }),
  };
}

export function blockCopy(locale: string): BlockCopy {
  const t = ui(locale);
  return {
    callout: {
      info: t('block.callout.info'),
      note: t('block.callout.note'),
      warning: t('block.callout.warning'),
    },
    photographer: t('block.credit.photographer'),
    videoOn: t('block.video.on'),
    footnotes: t('block.footnotes'),
    footnoteBack: t('block.footnote.back'),
    honeypotLabel: t('form.honeypot.label'),
    summaryTitle: t('error.summary.title'),
  };
}

/** The width `src` aims for: enough for a content column, small enough for an old browser. */
const FALLBACK_WIDTH = 960;

function renderImage(
  asset: MediaView | null,
  use: {
    decorative: boolean;
    alt: Partial<Record<string, string>> | null;
    caption?: Partial<Record<string, string>> | undefined;
    credit?: MediaCredit | undefined;
  },
  locale: string
): RenderImage | null {
  if (!asset || asset.access !== 'public' || asset.kind !== 'image' || asset.state !== 'ready')
    return null;
  if (asset.width === null || asset.height === null) return null;
  const widths = (format: string) =>
    asset.variants
      .filter((v) => v.format === format && /^w\d+$/.test(v.name) && v.width !== null && v.path)
      .sort((a, b) => a.width! - b.width!);
  const webp = widths('webp');
  const avif = widths('avif');
  const fallback =
    [...webp].reverse().find((v) => v.width! <= FALLBACK_WIDTH) ??
    webp[0] ??
    asset.variants.find((v) => v.name === 'file' && v.path);
  if (!fallback) return null;
  const srcset = (vs: typeof webp) => vs.map((v) => `${v.path} ${v.width}w`).join(', ');
  // The block's caption wins, an empty one hides the asset's; a missing translation stays missing.
  const own = use.caption?.[locale];
  const caption = own !== undefined ? own : (asset.caption[locale] ?? '');
  const credit = use.credit ?? asset.credit;
  const q = (n: number) => Math.min(10, Math.max(0, Math.round(n * 10)));
  return {
    alt: use.decorative ? '' : (use.alt?.[locale] ?? ''),
    width: asset.width,
    height: asset.height,
    src: fallback.path,
    srcset: srcset(webp),
    avifSrcset: srcset(avif),
    caption: caption.trim() ? caption : null,
    credit: credit.work || credit.photographer ? credit : null,
    focal: { x: q(asset.focal.x), y: q(asset.focal.y) },
  };
}

export async function resolveDocument(
  source: ResolveSource,
  projection: Projection,
  options: {
    base: string;
    /** Form copy falls back to the tenant's default locale, as the probe did. */
    fallbackLocale: string;
  }
): Promise<RenderModel> {
  const { locale } = projection;
  const blocks = allBlocks(projection.blocks);

  // Every reference once, in document order; sequential so one request holds one connection.
  const mediaIds = new Set<string>();
  const formIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const b of blocks)
    for (const ref of referencesOf(b))
      (ref.type === 'media' ? mediaIds : ref.type === 'form' ? formIds : itemIds).add(ref.refId);
  const media = new Map<string, MediaView | null>();
  for (const id of mediaIds) media.set(id, await source.media(id));
  const forms = new Map<string, RenderForm | null>();
  for (const id of formIds)
    forms.set(id, toRenderForm(await source.form(id), locale, options.fallbackLocale));
  const links: Record<string, string | null> = {};
  for (const id of itemIds) links[id] = await source.itemPath(id, locale);

  const text = (v: Partial<Record<string, string>> | undefined) => v?.[locale] ?? null;
  const actions = (
    list: readonly {
      label: Partial<Record<string, string>>;
      target: { kind: 'item'; itemId: string } | { kind: 'url'; url: string };
    }[]
  ): RenderAction[] =>
    list.flatMap((a) => {
      const href = a.target.kind === 'item' ? links[a.target.itemId] : a.target.url;
      const label = text(a.label);
      return href && label ? [{ label, href }] : [];
    });

  const out: RenderBlock[] = blocks.map((b): RenderBlock => {
    const id = b.id;
    switch (b.type) {
      case 'heading':
        return { id, type: 'heading', text: text(b.props.text) ?? '' };
      case 'rich-text':
        return { id, type: 'rich-text', doc: b.props.content[locale]! };
      case 'paywall':
        return { id, type: 'paywall' };
      case 'image':
        return {
          id,
          type: 'image',
          layout: b.props.layout,
          image: renderImage(media.get(b.props.mediaId) ?? null, b.props, locale),
        };
      case 'hero': {
        const image = b.props.image
          ? renderImage(media.get(b.props.image.mediaId) ?? null, b.props.image, locale)
          : null;
        return {
          id,
          type: 'hero',
          // Text never sits on a photo; without a renderable image a hero is minimal.
          variant: image ? b.props.variant : 'minimal',
          title: text(b.props.title) ?? '',
          body: text(b.props.body),
          image: b.props.variant === 'minimal' ? null : image,
          actions: actions(b.props.actions),
          width: b.props.width,
          align: b.props.align,
        };
      }
      case 'cta':
        return {
          id,
          type: 'cta',
          variant: b.props.variant,
          title: text(b.props.title) ?? '',
          body: text(b.props.body),
          actions: actions(b.props.actions),
          width: b.props.width,
          align: b.props.align,
        };
      case 'callout':
        return {
          id,
          type: 'callout',
          variant: b.props.variant,
          title: text(b.props.title),
          body: b.props.body[locale]!,
        };
      case 'faq':
        return {
          id,
          type: 'faq',
          variant: b.props.variant,
          title: text(b.props.title),
          entries: b.props.entries.map((e) => ({
            question: text(e.question) ?? '',
            answer: e.answer[locale]!,
          })),
        };
      case 'quote':
        return {
          id,
          type: 'quote',
          variant: b.props.variant,
          width: b.props.width,
          text: text(b.props.text) ?? '',
          name: b.props.attribution.name,
          role: text(b.props.attribution.role),
          source: text(b.props.attribution.source),
          url: b.props.attribution.url ?? null,
        };
      case 'video-embed':
        return {
          id,
          type: 'video-embed',
          provider: b.props.provider,
          url: videoUrl(b.props.provider, b.props.videoId),
          title: text(b.props.title) ?? '',
          caption: text(b.props.caption) || null,
          width: b.props.width,
        };
      case 'form':
        return {
          id,
          type: 'form',
          variant: b.props.variant,
          width: b.props.width,
          form: forms.get(b.props.formId) ?? null,
        };
      case 'signup-form':
        // The legacy type renders as a default form: one form component for both (brief § 2).
        return {
          id,
          type: 'form',
          variant: 'default',
          width: 'content',
          form: forms.get(b.props.formId) ?? null,
        };
      default:
        return b satisfies never;
    }
  });

  return {
    locale,
    title: projection.title,
    base: options.base,
    blocks: out,
    links,
    copy: blockCopy(locale),
  };
}

/** The references the resolver needs; rich-text links are read from the projected locale only. */
function referencesOf(b: Block): { type: 'media' | 'form' | 'item'; refId: string }[] {
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

function toRenderForm(
  found: { form: FormDefinition; startedToken: string } | null,
  locale: string,
  fallback: string
): RenderForm | null {
  if (!found) return null;
  const { form, startedToken } = found;
  // Form copy has its own locales and falls back to the tenant default, as the probe did; the
  // page content around it needs no fallback, it is already one locale.
  const text = (value: Partial<Record<string, string>>) => pick(value, locale, fallback) ?? '';
  return {
    formId: form.id,
    startedToken,
    submitLabel: text(form.submitLabel),
    thankYou: text(form.thankYou),
    fields: form.fields.map((f) => ({
      name: f.name,
      type: f.type,
      label: text(f.label),
      required: f.required,
    })),
  };
}
