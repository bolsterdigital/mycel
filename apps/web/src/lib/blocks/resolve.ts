// The one server-side resolver (brief #8c § 1): from a published projection to the render model,
// fetching every tenant reference the blocks make once, up front. Components never reach the
// database, so the same renderer runs on a preview (#11) and in the conformance suite without
// one.
//
// What a reference turns into is decided here, and it fails closed:
//   - media: `media.get`; a restricted, deleted, failed or non-image asset is null, and the block
//     renders nothing (no figure, no alt, no path). Signed paths for readers are #19.
//     A document slot has the same rule for a document: the entry is left out, and a block with
//     no file left renders nothing.
//   - forms: `form.get` with a fresh `startedToken`, as the probe did; unknown is null.
//   - campaigns: `campaign.card.get`, the landing page's published revision in this locale with
//     the participation phase now and the public count (ADR 033 rule 4); an unavailable campaign
//     is null and its card renders nothing, with the reason only for the admin preview. A form
//     bound to a campaign that does not accept participation now renders where the campaign
//     stands instead of its fields (rule 2); the submit path decides anyway (rule 3).
//   - items: a public path only if the item is published in this locale and its published
//     revision is `access.level: public`, the rules of `content.published.get`; otherwise null,
//     so an action without a target is dropped and a text link becomes text. The path follows
//     the route grammar (`contentPath`): locale prefix for a non-default locale, `articles/`.
//
// No locks, no writes. Rejected: resolving inside each component (a query per block, and a
// renderer that cannot run without a database), and passing the whole `MediaView` through
// (restricted paths would sit in the model even if no component printed them).

import { personPath } from '../public/person-path.js';
import { formatBytes } from '../admin/format.js';
import {
  fieldPattern,
  type FormDefinition,
  type PublicPersonCard,
  resolvePeopleGrid,
  resolveCreditPerson,
  type BlockProps,
  type ArticleHeader,
  type CampaignCard,
  formCampaignCard,
  type ProofChallenge,
  type Invoker,
  type MediaView,
  type Principal,
  type UnitOfWork,
  UseCaseError,
  allBlocks,
  contentPath,
  linkedItemIds,
  pick,
  translate,
  statusOf,
  useCases,
  type Block,
  type MediaCredit,
} from '@mycel/core';
import { ui } from '../../i18n/index.js';
import { creditWords } from './credit.js';
import { headingsAboveFloats } from './float-order.js';
import type {
  BlockCopy,
  RenderAction,
  RenderBlock,
  RenderCampaign,
  RenderForm,
  RenderImage,
  RenderIntro,
  RenderModel,
} from './model.js';
import { videoUrl, type RenderMeta } from './model.js';

/** Where the resolver reads tenant data; `runtimeSource` is the real one, tests may stub it. */
export interface ResolveSource {
  defaultLocale?: string;
  creditPerson?(id: string): Promise<{ name: string; slug: string | null } | null>;
  peopleGrid?(props: BlockProps<'people-grid'>, locale: string): Promise<PublicPersonCard[]>;
  form(id: string): Promise<{
    form: FormDefinition;
    startedToken: string;
    proof: ProofChallenge;
    version?: string;
  } | null>;
  media(id: string): Promise<MediaView | null>;
  itemPath(itemId: string, locale: string): Promise<string | null>;
  /** A campaign as a card shows it; absent in fixtures without campaigns. */
  campaignCard?(campaignId: string, locale: string): Promise<CampaignCard>;
  /** The card of the campaign a form is bound to, or null when it is bound to none. */
  formCampaign?(formId: string, locale: string): Promise<CampaignCard | null>;
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
 * for the item check, which needs no projection of the target. `reader` is the visitor's
 * anonymous principal for the site, with `content:read`, `forms:read` and `media:read`;
 * `defaultLocale` is the site's, the one locale without a path prefix.
 */
export function runtimeSource(deps: {
  invoker: Invoker;
  uow: UnitOfWork;
  reader: Principal;
  defaultLocale: string;
}): ResolveSource {
  const { invoker, uow, reader, defaultLocale } = deps;
  return {
    defaultLocale,
    creditPerson: (id) => uow.run(reader, (ctx) => resolveCreditPerson(ctx, id)),
    async peopleGrid(props, locale) {
      return uow.run(reader, (ctx) => resolvePeopleGrid(ctx, props, locale));
    },
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
    campaignCard: (campaignId, locale) =>
      invoker.run(useCases.getCampaignCard, reader, { campaignId, locale }),
    formCampaign: (formId, locale) =>
      uow.run(reader, (ctx) => formCampaignCard(ctx, formId, locale)),
    itemPath: (itemId, locale) =>
      uow.run(reader, async (ctx) => {
        const item = await ctx.content.get(itemId);
        if (!item) return null;
        const state = item.publication.find(
          (s) => s.locale === locale && statusOf(s) === 'published'
        );
        if (!state?.publishedRevisionId) return null;
        const revision = await ctx.content.revision(item.id, state.publishedRevisionId);
        if (!revision || revision.document.access.level !== 'public') return null;
        return contentPath(item, locale, defaultLocale);
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
    galleryRow: t('block.gallery.row'),
    audioDownload: t('block.audio.download'),
    audioTranscript: t('block.audio.transcript'),
    credit: creditWords(t),
    videoOn: t('block.video.on'),
    footnotes: t('block.footnotes'),
    footnoteBack: t('block.footnote.back'),
    toContent: t('block.cover.toContent'),
    lightbox: {
      enlarge: t('block.lightbox.enlarge'),
      dialog: t('block.lightbox.dialog'),
      close: t('block.lightbox.close'),
      previous: t('block.lightbox.previous'),
      next: t('block.lightbox.next'),
      zoom: t('block.lightbox.zoom'),
      count: t('block.lightbox.count'),
    },
    honeypotLabel: t('form.honeypot.label'),
    summaryTitle: t('error.summary.title'),
    campaign: {
      kind: {
        petition: t('block.campaign.kind.petition'),
        signup: t('block.campaign.kind.signup'),
        fundraiser: t('block.campaign.kind.fundraiser'),
      },
      phase: {
        upcoming: t('block.campaign.phase.upcoming'),
        open: t('block.campaign.phase.open'),
        closed: t('block.campaign.phase.closed'),
      },
      unit: {
        petition: t('block.campaign.unit.petition'),
        signup: t('block.campaign.unit.signup'),
        fundraiser: t('block.campaign.unit.fundraiser'),
      },
      ofTarget: t('block.campaign.ofTarget'),
      act: {
        petition: t('block.campaign.act.petition'),
        signup: t('block.campaign.act.signup'),
        fundraiser: t('block.campaign.act.fundraiser'),
      },
      more: t('block.campaign.more'),
      notOpen: {
        upcoming: t('block.campaign.notOpen.upcoming'),
        closed: t('block.campaign.notOpen.closed'),
      },
    },
  };
}

/** The width `src` aims for: enough for a content column, small enough for an old browser. */
const FALLBACK_WIDTH = 960;

function renderAssetImage(
  asset: MediaView | null,
  use: {
    decorative: boolean;
    alt: Partial<Record<string, string>> | null;
    caption?: Partial<Record<string, string>> | undefined;
    credit?: NonNullable<RenderImage['credit']> | undefined;
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
  const widest = webp[webp.length - 1];
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
    large: widest
      ? {
          src: widest.path,
          width: widest.width!,
          height: Math.round((widest.width! * asset.height) / asset.width),
        }
      : null,
  };
}

/** Where a visitor fetches a document and what it is ("PDF, 845 kB"); fails closed like an image. */
function renderFile(
  asset: MediaView | null,
  locale: string,
  kind: 'document' | 'audio' = 'document'
): { href: string; meta: string } | null {
  if (!asset || asset.access !== 'public' || asset.kind !== kind || asset.state !== 'ready')
    return null;
  const file = asset.variants.find((v) => v.name === 'file' && v.path);
  if (!file) return null;
  const meta = `${file.format.toUpperCase()}, ${formatBytes(asset.sizeBytes, locale)}`;
  return { href: file.path, meta };
}

/**
 * What sits between an item's title and its blocks (#86): the lead in this locale and the hero
 * image. A hero with an alt in this locale describes the image (#99); without one it is
 * decorative and the title and lead above it carry the meaning. Caption and credit are the
 * asset's either way.
 */
export async function resolveIntro(
  source: ResolveSource,
  intro: {
    lead: string | null;
    heroImageId: string | null;
    heroAlt: string | null;
    header?: ArticleHeader;
    meta?: RenderMeta | null;
  },
  locale: string
): Promise<RenderIntro> {
  const asset = intro.heroImageId ? await source.media(intro.heroImageId) : null;
  const use = intro.heroAlt
    ? { decorative: false, alt: { [locale]: intro.heroAlt } }
    : { decorative: true, alt: null };
  const credit = await resolvedCredit(
    source,
    asset?.credit,
    locale,
    source.defaultLocale ?? locale
  );
  const hero = renderAssetImage(asset, { ...use, ...(credit ? { credit } : {}) }, locale);
  return {
    lead: intro.lead,
    hero,
    header: hero && intro.header === 'cover' ? 'cover' : 'standard',
    meta: intro.meta ?? null,
  };
}

/**
 * An article's line under its header (brief #105 rule 3): the date in the site's time zone, the
 * authors, the section; null when there is nothing to say. Names stay plain text until author
 * pages exist. Rejected: a date formatted in the browser, which needs a script and shifts the
 * page after load.
 */
export function renderMeta(
  meta: { publishedAt: string | null; authors: readonly string[]; section: string | null },
  locale: string,
  timeZone: string
): RenderMeta | null {
  const { publishedAt, authors, section } = meta;
  if (!publishedAt && !authors.length && !section) return null;
  const at = publishedAt ? new Date(publishedAt) : null;
  const names = new Intl.ListFormat(locale, { type: 'conjunction' }).format(authors);
  return {
    date: at && {
      // en-CA writes the ISO order; the attribute is a date in the same zone as the label.
      iso: new Intl.DateTimeFormat('en-CA', { timeZone }).format(at),
      label: new Intl.DateTimeFormat(locale, { timeZone, dateStyle: 'long' }).format(at),
    },
    // A function, so `$&` in a name stays text instead of a replacement pattern.
    byline: authors.length ? ui(locale)('block.meta.by').replace('{names}', () => names) : null,
    section,
  };
}

export async function resolveDocument(
  source: ResolveSource,
  projection: Projection,
  options: {
    base: string;
    /** Form copy falls back to the tenant's default locale, as the probe did. */
    fallbackLocale: string;
    /**
     * Keep why a campaign card shows nothing (`diagnosis`): the admin preview only. The public
     * page never carries it, so its HTML and data say nothing about a draft or archived campaign.
     */
    diagnose?: boolean;
  }
): Promise<RenderModel> {
  const { locale } = projection;
  const blocks = allBlocks(projection.blocks);

  // Every reference once, in document order; sequential so one request holds one connection.
  const mediaIds = new Set<string>();
  const formIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const b of blocks)
    for (const ref of referencesOf(b).filter((ref) => ['media', 'form', 'item'].includes(ref.type)))
      (ref.type === 'media' ? mediaIds : ref.type === 'form' ? formIds : itemIds).add(ref.refId);
  // Campaign cards first: an available one adds its image to the media and, on a `full` card
  // while participation is open, its form to the forms. A form block asks whether its form is
  // bound to a campaign that does not accept participation now.
  const cards = new Map<string, CampaignCard>();
  for (const b of blocks) {
    if (b.type !== 'campaign-card' || cards.has(b.props.campaignId)) continue;
    const card = source.campaignCard
      ? await source.campaignCard(b.props.campaignId, locale)
      : ({ available: false, campaignId: b.props.campaignId, reason: 'unknown' } as const);
    cards.set(b.props.campaignId, card);
    if (card.available && card.landing.imageId) mediaIds.add(card.landing.imageId);
  }
  for (const b of blocks)
    if (b.type === 'campaign-card' && b.props.variant === 'full') {
      const card = cards.get(b.props.campaignId);
      if (card?.available && card.formId) formIds.add(card.formId);
    }
  const gates = new Map<string, CampaignCard | null>();
  for (const b of blocks)
    if ((b.type === 'form' || b.type === 'signup-form') && !gates.has(b.props.formId)) {
      const gate = (await source.formCampaign?.(b.props.formId, locale)) ?? null;
      gates.set(b.props.formId, gate);
      if (gate?.available && gate.phase !== 'open' && gate.landing.imageId)
        mediaIds.add(gate.landing.imageId);
    }
  const grids = new Map<string, PublicPersonCard[]>();
  for (const b of blocks) {
    if (b.type !== 'people-grid') continue;
    const people = (await source.peopleGrid?.(b.props, locale)) ?? [];
    grids.set(b.id, people);
    for (const person of people) if (person.imageId) mediaIds.add(person.imageId);
  }
  const media = new Map<string, MediaView | null>();
  for (const id of mediaIds) media.set(id, await source.media(id));
  const credits = new Map<string, { name: string; slug: string | null } | null>();
  const collect = async (value: unknown): Promise<void> => {
    if (!value || typeof value !== 'object') return;
    if ('photographerPersonId' in value && typeof value.photographerPersonId === 'string') {
      const credit = value as MediaCredit;
      if (!credits.has(credit.photographerPersonId!)) {
        credits.set(
          credit.photographerPersonId!,
          (await source.creditPerson?.(credit.photographerPersonId!)) ?? null
        );
      }
    }
    for (const child of Object.values(value)) await collect(child);
  };
  for (const asset of media.values()) await collect(asset?.credit);
  for (const block of blocks) await collect(block.props);
  const renderImage: typeof renderAssetImage = (asset, use, language) => {
    const credit = use.credit ?? asset?.credit;
    const resolved = credit?.photographerPersonId ? credits.get(credit.photographerPersonId) : null;
    return renderAssetImage(
      asset,
      {
        ...use,
        ...(credit
          ? {
              credit: resolved
                ? {
                    ...credit,
                    photographer: resolved.name,
                    photographerHref: resolved.slug
                      ? personPath(resolved.slug, locale, options.fallbackLocale)
                      : null,
                  }
                : credit.photographerPersonId
                  ? // ADR 034 rule 4: an absent person shows nobody, never the free text beside it.
                    { ...credit, photographer: null }
                  : credit,
            }
          : {}),
      },
      language
    );
  };
  const forms = new Map<string, RenderForm | null>();
  for (const id of formIds)
    forms.set(id, toRenderForm(await source.form(id), locale, options.fallbackLocale));
  const links: Record<string, string | null> = {};
  for (const id of itemIds) links[id] = await source.itemPath(id, locale);

  const defaultLocale = source.defaultLocale ?? options.fallbackLocale;
  const campaign = (card: CampaignCard | null | undefined): RenderCampaign | null =>
    card?.available
      ? {
          campaignId: card.campaignId,
          kind: card.kind,
          phase: card.phase,
          href: contentPath(card.landing, locale, defaultLocale),
          title: card.landing.title,
          summary: card.landing.summary,
          image: card.landing.imageId
            ? renderImage(
                media.get(card.landing.imageId) ?? null,
                { decorative: true, alt: null },
                locale
              )
            : null,
          counter: card.counter,
          revisionId: card.landing.revisionId,
        }
      : null;
  // One form per definition per page: element ids derive from the form id, so a card whose form
  // a form block or an earlier card already shows renders as compact (ADR 033 rule 4).
  const shownForms = new Set(
    blocks.flatMap((b) => (b.type === 'form' || b.type === 'signup-form' ? [b.props.formId] : []))
  );
  /** The bound form while participation is not open is replaced by where it stands (rule 2). */
  const formBlock = (
    id: string,
    formId: string,
    variant: 'default' | 'card',
    width: 'content' | 'wide' | 'full'
  ): RenderBlock => {
    const gate = gates.get(formId) ?? null;
    if (gate && (!gate.available || gate.phase !== 'open'))
      return { id, type: 'form', variant, width, form: null, campaign: campaign(gate) };
    return { id, type: 'form', variant, width, form: forms.get(formId) ?? null };
  };

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
      case 'people-grid':
        return {
          id,
          type: 'people-grid',
          columns: b.props.columns,
          showRole: b.props.showRole,
          showBio: b.props.showBio,
          showContact: b.props.showContact,
          people: (grids.get(id) ?? []).map((person) => ({
            ...person,
            image: renderImage(
              media.get(person.imageId ?? '') ?? null,
              { decorative: true, alt: null },
              locale
            ),
            href: person.pageEnabled
              ? personPath(person.slug, locale, options.fallbackLocale)
              : null,
          })),
        };
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
      case 'cards':
        return {
          id,
          type: 'cards',
          accent: b.props.accent,
          width: b.props.width,
          cards: b.props.cards.map((c) => ({
            title: text(c.title) ?? '',
            body: text(c.body),
            actions: actions(c.actions),
          })),
        };
      case 'file-download':
        return {
          id,
          type: 'file-download',
          title: text(b.props.title),
          body: text(b.props.body),
          files: b.props.files.flatMap((f) => {
            const file = renderFile(media.get(f.fileId) ?? null, locale);
            return file ? [{ ...file, label: text(f.name) ?? '' }] : [];
          }),
        };
      case 'audio':
        return {
          id,
          type: 'audio',
          title: text(b.props.title) ?? '',
          file: renderFile(media.get(b.props.fileId) ?? null, locale, 'audio'),
          transcript: text(b.props.transcript),
        };
      case 'gallery':
        return {
          id,
          type: 'gallery',
          variant: b.props.variant,
          width: b.props.width,
          images: b.props.images.flatMap((use) => {
            const image = renderImage(media.get(use.mediaId) ?? null, use, locale);
            return image ? [image] : [];
          }),
        };
      case 'timeline': {
        // A calendar date has no zone: written in UTC, read in UTC, so no server shifts it a day.
        const dateLabel = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'long' });
        const newestFirst = b.props.order === 'newest';
        return {
          id,
          type: 'timeline',
          title: text(b.props.title),
          // A stable sort: two events on one date stay in the order the editor gave them.
          events: [...b.props.events]
            .sort((x, y) =>
              newestFirst ? y.date.localeCompare(x.date) : x.date.localeCompare(y.date)
            )
            .map((e) => ({
              date: e.date,
              dateLabel: dateLabel.format(new Date(`${e.date}T00:00:00Z`)),
              title: text(e.title) ?? '',
              body: text(e.body),
              actions: actions(e.actions),
            })),
        };
      }
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
          width: b.props.width,
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
        return formBlock(id, b.props.formId, b.props.variant, b.props.width);
      case 'signup-form':
        // The legacy type renders as a default form: one form component for both (brief § 2).
        return formBlock(id, b.props.formId, 'default', 'content');
      case 'campaign-card': {
        const card = cards.get(b.props.campaignId);
        const formId =
          card?.available && b.props.variant === 'full' && !shownForms.has(card.formId ?? '')
            ? card.formId
            : null;
        if (formId) shownForms.add(formId);
        return {
          id,
          type: 'campaign-card',
          variant: b.props.variant,
          width: b.props.width,
          campaign: campaign(card),
          form: formId ? (forms.get(formId) ?? null) : null,
          ...(options.diagnose && card && !card.available ? { diagnosis: card.reason } : {}),
        };
      }
      default:
        return b satisfies never;
    }
  });

  return {
    locale,
    title: projection.title,
    base: options.base,
    blocks: headingsAboveFloats(out),
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
    case 'cards':
      return b.props.cards.flatMap((c) => targets(c.actions));
    case 'file-download':
      return b.props.files.map((f) => ({ type: 'media' as const, refId: f.fileId }));
    case 'audio':
      return [{ type: 'media' as const, refId: b.props.fileId }];
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

function toRenderForm(
  found: {
    form: FormDefinition;
    startedToken: string;
    proof: ProofChallenge;
    version?: string;
  } | null,
  locale: string,
  fallback: string
): RenderForm | null {
  if (!found) return null;
  const { form, startedToken, proof } = found;
  // Form copy has its own locales and falls back to the tenant default, as the probe did; the
  // page content around it needs no fallback, it is already one locale.
  const text = (value: Partial<Record<string, string>>) => pick(value, locale, fallback) ?? '';
  return {
    formId: form.id,
    version: found.version,
    conditionalHelp: form.fields.some((f) => f.activeWhen || f.requiredWhen)
      ? translate(locale, 'forms.conditional.help')
      : undefined,
    startedToken,
    proof,
    submitLabel: text(form.submitLabel),
    thankYou: text(form.thankYou),
    fields: form.fields.map((f) => ({
      id: f.id ?? f.name,
      pattern: fieldPattern(f.type),
      baseRequired: f.required,
      activeWhen: f.activeWhen,
      requiredWhen: f.requiredWhen,
      name: f.name,
      type: f.type,
      label: text(f.label),
      required: f.required && !f.activeWhen,
      conditional: !!(f.activeWhen || f.requiredWhen),
      help: f.help ? text(f.help) : undefined,
      ...('options' in f
        ? { options: f.options.map((o) => ({ value: o.value, label: text(o.label) })) }
        : {}),
      ...('value' in f ? { value: f.value } : {}),
      ...('min' in f ? { min: f.min, max: f.max } : {}),
      ...('maxLength' in f ? { maxLength: f.maxLength } : {}),
    })),
  };
}

/** Resolve on read without copying a person's name into an immutable document or media row. */
async function resolvedCredit(
  source: ResolveSource,
  credit: MediaCredit | undefined,
  locale: string,
  defaultLocale: string
): Promise<NonNullable<RenderImage['credit']> | undefined> {
  if (!credit?.photographerPersonId) return credit;
  const person = await source.creditPerson?.(credit.photographerPersonId);
  // ADR 034 rule 4: an absent person shows nobody, never the free text stored beside the id.
  return person
    ? {
        ...credit,
        photographer: person.name,
        photographerHref: person.slug ? personPath(person.slug, locale, defaultLocale) : null,
      }
    : { ...credit, photographer: null };
}
