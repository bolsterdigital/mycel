// The one server-side resolver (brief #8c § 1): from a published projection to the render model,
// fetching every tenant reference the blocks make once, up front. Components never reach the
// database, so the same renderer runs on a preview (#11) and in the conformance suite without
// one.
//
// What a reference turns into is decided here, and it fails closed:
//   - media: `media.get`; a restricted, deleted, failed or non-image asset is null, and the block
//     renders nothing (no figure, no alt, no path). A reader with access brings the item's own
//     restricted media with signed paths (`readerMedia` of the published item); they stand in
//     for the item's own blocks and hero only, never for a card, entry or person beside them.
//     A document slot has the same rule for a document: the entry is left out, and a block with
//     no file left renders nothing.
//   - forms: `form.get` with a fresh `startedToken`, as the probe did; unknown is null.
//   - campaigns: `campaign.card.get`, the landing page's published revision in this locale with
//     the participation phase now and the public count (ADR 033 rule 4); an unavailable campaign
//     is null and its card renders nothing, with the reason only for the admin preview. A form
//     bound to a campaign that does not accept participation now renders where the campaign
//     stands instead of its fields (rule 2); the submit path decides anyway (rule 3).
//   - items: a public path only if the item is published in this locale (`publicItemPath`, the
//     rule of `content.published.get`; a restricted item's address serves its teaser, a zone has
//     none); otherwise null, so an action without a target is dropped and a text link becomes
//     text. The path follows the route grammar (`contentPath`): locale prefix for a non-default
//     locale, `articles/`.
//
// No locks, no writes. Rejected: resolving inside each component (a query per block, and a
// renderer that cannot run without a database), and passing the whole `MediaView` through
// (restricted paths would sit in the model even if no component printed them).

import { personPath } from '../public/person-path.js';
import { formatBytes } from '../admin/format.js';
import {
  wallClock,
  fieldPattern,
  type FormDefinition,
  type PublicPersonCard,
  resolvePeopleGrid,
  resolveCreditPerson,
  type BlockProps,
  type ArticleHeader,
  type CampaignCard,
  type LandingCampaign,
  landingCampaignOf,
  type Overview,
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
  publicItemPath,
  useCases,
  type Block,
  type MediaCredit,
  type MediaLicence,
  LICENCE_URLS,
} from '@mycel/core';
import { ui } from '../../i18n/index.js';
import { amountChoices, membershipChoices } from './amount-field.js';
import { blockCopy } from './copy.js';
import { headingsAboveFloats } from './float-order.js';
import { opensInCard } from './card-body.js';
import { opensOf, renderLanding } from './campaign-render.js';
import type {
  RenderAction,
  RenderBlock,
  RenderCampaign,
  RenderForm,
  RenderImage,
  RenderCorrections,
  RenderIntro,
  RenderModel,
  CardPlaceholder,
} from './model.js';
import { videoPlayerUrl, videoUrl, type RenderEvent, type RenderMeta } from './model.js';

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
  /** The campaign a page is the landing page of, or null (ADR 038 rule 2). */
  landingCampaign?(itemId: string): Promise<LandingCampaign | null>;
  /** What an overview block lists on one page; absent in fixtures without one. */
  overview?(props: BlockProps<'overview'>, locale: string, page: number): Promise<Overview>;
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
    landingCampaign: (itemId) => uow.run(reader, (ctx) => landingCampaignOf(ctx, itemId)),
    overview: (props, locale, page) =>
      invoker.run(useCases.getOverview, reader, { props, locale, page }),
    itemPath: (itemId, locale) =>
      uow.run(reader, (ctx) => publicItemPath(ctx, itemId, locale, defaultLocale)),
  };
}

export { blockCopy };

/** The width `src` aims for: enough for a content column, small enough for an old browser. */
const FALLBACK_WIDTH = 960;

/** A licence in this locale's words and its link; `other` is named by its own text. */
function renderLicence(licence: MediaLicence | null, locale: string) {
  if (!licence) return null;
  const label = licence.text ?? ui(locale)(`block.licence.${licence.code}`);
  return { label, href: LICENCE_URLS[licence.code] };
}

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
  if (!asset || !delivered(asset) || asset.kind !== 'image' || asset.state !== 'ready') return null;
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
  const licence = renderLicence(asset.licence, locale);
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
    // The licence belongs to the file, so a block's own credit keeps the asset's licence.
    credit: credit.work || credit.photographer || licence ? { ...credit, licence } : null,
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

/**
 * Whether an asset has addresses to print: a public one, or a restricted one whose every variant
 * came signed for this reader. A visitor's view of a restricted asset has none, so it fails closed.
 */
const delivered = (asset: MediaView): boolean =>
  asset.access === 'public' ||
  (asset.variants.length > 0 && asset.variants.every((v) => v.path !== ''));

/** Where a visitor fetches a document and what it is ("PDF, 845 kB"); fails closed like an image. */
function renderFile(
  asset: MediaView | null,
  locale: string,
  kind: 'document' | 'audio' = 'document'
): { href: string; meta: string } | null {
  if (!asset || !delivered(asset) || asset.kind !== kind || asset.state !== 'ready') return null;
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
    event?: RenderEvent | null;
  },
  locale: string,
  /** The item's restricted media signed for a reader with access (`readerMedia`). */
  signed: Readonly<Record<string, MediaView>> = {}
): Promise<RenderIntro> {
  const id = intro.heroImageId;
  const asset = id ? (signed[id] ?? (await source.media(id))) : null;
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
    ...(intro.event ? { event: intro.event } : {}),
  };
}

/**
 * An event's when and where. The times are the site's wall clock, so they are formatted as
 * UTC: no zone shifts them a second time. A range on one day names the day once. Rejected: the
 * zone's name beside the time, which a visitor of a local event does not need.
 */
/**
 * The time an overview card shows: an event's when (as its own header writes it) and place,
 * else the first publication as a date.
 */
export function overviewWhen(e: Overview['entries'][number], locale: string, tz: string) {
  if (e.event) {
    const { when, where, online } = renderEvent(e.event, locale);
    return {
      date: { iso: when.iso, label: when.label },
      place: where?.text ?? online?.text ?? null,
    };
  }
  const at = new Date(e.date);
  return {
    date: {
      iso: new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at),
      label: new Intl.DateTimeFormat(locale, { timeZone: tz, dateStyle: 'long' }).format(at),
    },
    place: null,
  };
}

export function renderEvent(
  event: {
    startsAt: string;
    endsAt: string | null;
    location: string | null;
    onlineUrl: string | null;
  },
  locale: string
): RenderEvent {
  const t = ui(locale);
  const at = (v: string) => new Date(`${v}:00Z`);
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const label =
    event.endsAt && event.endsAt !== event.startsAt
      ? format.formatRange(at(event.startsAt), at(event.endsAt))
      : format.format(at(event.startsAt));
  return {
    when: { iso: event.startsAt, label, term: t('block.event.when') },
    where: event.location ? { text: event.location, term: t('block.event.where') } : null,
    online: event.onlineUrl
      ? {
          href: event.onlineUrl,
          text: new URL(event.onlineUrl).host,
          term: t('block.event.online'),
        }
      : null,
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

/**
 * An article's corrections (ADR 012 rule 1) in this locale; null without any, which is also what
 * a teaser gets, since the core leaves them out of it. A correction's date is a calendar date, so
 * it is formatted as such, in no zone.
 */
export function renderCorrections(
  corrections: readonly { date: string; text: string }[] | undefined,
  locale: string
): RenderCorrections | null {
  if (!corrections?.length) return null;
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' });
  return {
    title: ui(locale)('block.corrections.title'),
    entries: corrections.map((c) => ({
      date: { iso: c.date, label: format.format(new Date(`${c.date}T00:00:00Z`)) },
      text: c.text,
    })),
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
     * Keep why a campaign card shows nothing, and keep a campaign's form with the reason the
     * public page withholds it (`diagnosis`): the admin preview only. The public page never
     * carries it, so its HTML and data say nothing about a draft or archived campaign.
     */
    diagnose?: boolean;
    /**
     * The page of an overview with an archive (`?p=`) and the host's own site-root path, which
     * its page links point at; page 1 without either.
     */
    page?: number;
    path?: string;
    /** The site's time zone for an overview's dates; UTC where a caller has none. */
    timeZone?: string;
    /**
     * Today on the site's clock (`YYYY-MM-DD`), which splits a timeline into what happened and
     * what is to come (MY-278); by default the date in `timeZone` now. Read at render, never
     * stored, like an agenda's upcoming events: the page's ETag hashes the model, so the day an
     * event is reached gives a new tag.
     */
    today?: string;
    /** The item's restricted media signed for a reader with access (`readerMedia`). */
    signedMedia?: Readonly<Record<string, MediaView>>;
    /**
     * The item rendered, when it is one: a campaign's landing page renders in the campaign layout
     * with the campaign's form (ADR 038 rules 2 and 6). Absent for a zone or a fixture.
     */
    itemId?: string;
    /** The stand-in for a card without an image (MY-277); without it such a card has none. */
    placeholder?: CardPlaceholder;
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
  // The landing page's own campaign: its form comes from the campaign, not from the blocks.
  const landing =
    options.itemId && source.landingCampaign ? await source.landingCampaign(options.itemId) : null;
  if (landing?.formId) formIds.add(landing.formId);
  const cards = new Map<string, CampaignCard>();
  for (const b of blocks) {
    if (b.type !== 'campaign-card' || cards.has(b.props.campaignId)) continue;
    const card = source.campaignCard
      ? await source.campaignCard(b.props.campaignId, locale)
      : ({ available: false, campaignId: b.props.campaignId, reason: 'unknown' } as const);
    cards.set(b.props.campaignId, card);
    if (card.available && card.landing.imageId) mediaIds.add(card.landing.imageId);
  }
  // A full card also shows the campaign's text (ADR 038 rule 4): its blocks' media, links and
  // credits resolve with the page's own.
  const bodies: Block[] = [];
  for (const b of blocks)
    if (b.type === 'campaign-card' && b.props.variant === 'full') {
      const card = cards.get(b.props.campaignId);
      if (card?.available && card.formId) formIds.add(card.formId);
      if (card?.available && card.landing.body) bodies.push(...card.landing.body.blocks);
    }
  for (const b of bodies)
    for (const ref of referencesOf(b).filter((ref) => ref.type === 'media' || ref.type === 'item'))
      (ref.type === 'media' ? mediaIds : itemIds).add(ref.refId);
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
  // An overview reads its list once per block (one query for the list, one for the pins); only a
  // block with an archive follows `?p=`, so a second overview on the page stays on page 1.
  const page = options.page ?? 1;
  const overviews = new Map<string, Overview>();
  for (const b of blocks) {
    if (b.type !== 'overview') continue;
    const list = (await source.overview?.(b.props, locale, b.props.archive ? page : 1)) ?? {
      entries: [],
      older: false,
    };
    overviews.set(b.id, list);
    for (const entry of list.entries) if (entry.imageId) mediaIds.add(entry.imageId);
  }
  const media = new Map<string, MediaView | null>();
  for (const id of mediaIds) media.set(id, await source.media(id));
  // The item's own blocks: a signed view where the reader has one, else the visitor's.
  const signed = options.signedMedia ?? {};
  const own = (id: string): MediaView | null => signed[id] ?? media.get(id) ?? null;
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
  for (const asset of [...media.values(), ...Object.values(signed)]) await collect(asset?.credit);
  for (const block of [...blocks, ...bodies]) await collect(block.props);
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
  const timeZone = options.timeZone ?? 'UTC';
  const today = options.today ?? wallClock(new Date(), timeZone).slice(0, 10);
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
          opens: opensOf(card.phase, card.opensAt, locale, timeZone),
          revisionId: card.landing.revisionId,
        }
      : null;
  // One form per definition per page: element ids derive from the form id, so a card whose form
  // a form block or an earlier card already shows renders as compact (ADR 033 rule 4).
  const shownForms = new Set(
    blocks.flatMap((b) => (b.type === 'form' || b.type === 'signup-form' ? [b.props.formId] : []))
  );
  if (landing?.formId) shownForms.add(landing.formId);
  /** The bound form while participation is not open is replaced by where it stands (rule 2). */
  const formBlock = (
    id: string,
    formId: string,
    variant: 'default' | 'card',
    width: 'content' | 'wide' | 'full'
  ): RenderBlock => {
    // The campaign's own form stands in the action column; a block placing it renders nothing.
    if (formId === landing?.formId) return { id, type: 'form', variant, width, form: null };
    const gate = gates.get(formId) ?? null;
    const form = forms.get(formId) ?? null;
    if (!gate || (gate.available && gate.phase === 'open'))
      return { id, type: 'form', variant, width, form };
    // The admin preview keeps the form, which does not post there, and says what the public page
    // shows instead: an editor checks a form before opening participation, never by opening it.
    if (options.diagnose) {
      const diagnosis = gate.available ? (gate.phase as 'upcoming' | 'closed') : gate.reason;
      return { id, type: 'form', variant, width, form, diagnosis };
    }
    return { id, type: 'form', variant, width, form: null, campaign: campaign(gate) };
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

  const pageLink = (n: number) =>
    options.path === undefined ? null : n === 1 ? options.path : `${options.path}?p=${n}`;

  const renderBlock = (b: Block, id: string): RenderBlock => {
    switch (b.type) {
      case 'overview': {
        const list = overviews.get(id) ?? { entries: [], older: false };
        const paged = b.props.archive;
        return {
          id,
          type: 'overview',
          layout: b.props.layout,
          width: b.props.width,
          entries: list.entries.map((e) => ({
            id: e.id,
            href: contentPath(e, locale, defaultLocale),
            title: e.title,
            summary: e.summary,
            ...overviewWhen(e, locale, timeZone),
            image:
              b.props.layout === 'cards' && e.imageId
                ? renderImage(media.get(e.imageId) ?? null, { decorative: true, alt: null }, locale)
                : null,
            pinned: e.pinned,
            restricted: e.restricted,
            campaign: e.campaign ?? null,
            revisionId: e.revisionId,
          })),
          older: paged && list.older ? pageLink(page + 1) : null,
          newer: paged && page > 1 ? pageLink(page - 1) : null,
        };
      }
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
            // An organisation has no profile page; its name links to its own website (or its
            // first link) instead (ADR 031, 2026-11-16).
            href:
              person.kind === 'organisation'
                ? ((person.links.find((l) => l.kind === 'website') ?? person.links[0])?.url ?? null)
                : person.pageEnabled
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
          image: renderImage(own(b.props.mediaId), b.props, locale),
        };
      case 'hero': {
        const image = b.props.image
          ? renderImage(own(b.props.image.mediaId), b.props.image, locale)
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
            const file = renderFile(own(f.fileId), locale);
            return file ? [{ ...file, label: text(f.name) ?? '' }] : [];
          }),
        };
      case 'audio':
        return {
          id,
          type: 'audio',
          title: text(b.props.title) ?? '',
          file: renderFile(own(b.props.fileId), locale, 'audio'),
          transcript: text(b.props.transcript),
        };
      case 'gallery':
        return {
          id,
          type: 'gallery',
          variant: b.props.variant,
          width: b.props.width,
          images: b.props.images.flatMap((use) => {
            const image = renderImage(own(use.mediaId), use, locale);
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
              when: e.date <= today ? ('past' as const) : ('future' as const),
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
          player: videoPlayerUrl(b.props.provider, b.props.videoId),
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
        const full = card?.available && b.props.variant === 'full' ? card : null;
        const formId = full && !shownForms.has(full.formId ?? '') ? full.formId : null;
        if (formId) shownForms.add(formId);
        // Ids inside the card derive from the card's own, so two cards of one campaign differ.
        const body = full?.landing.body
          ? headingsAboveFloats(
              full.landing.body.blocks.map((inner) => renderBlock(inner, `${id}-${inner.id}`))
            )
          : null;
        return {
          id,
          type: 'campaign-card',
          variant: b.props.variant,
          width: b.props.width,
          campaign: campaign(card),
          form: formId ? (forms.get(formId) ?? null) : null,
          body:
            body && full?.landing.body
              ? { blocks: body, more: full.landing.body.more, open: opensInCard(body) }
              : null,
          ...(options.diagnose && card && !card.available ? { diagnosis: card.reason } : {}),
        };
      }
      default:
        return b satisfies never;
    }
  };
  const out = blocks.map((b) => renderBlock(b, b.id));

  return {
    locale,
    title: projection.title,
    base: options.base,
    ...(landing
      ? { campaign: renderLanding(landing, forms, locale, timeZone, options.diagnose) }
      : {}),
    blocks: headingsAboveFloats(out),
    links,
    copy: blockCopy(locale),
    ...(options.placeholder ? { placeholder: options.placeholder } : {}),
  };
}

/**
 * A landing page's campaign for its layout: the form only while open, except in the preview,
 * which keeps it with the reason the public page withholds it, as a bound form block does.
 */
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
    membership?: Parameters<typeof membershipChoices>[0];
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
    ...membershipChoices(found.membership, locale, fallback),
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
      ...amountChoices(f, locale),
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
