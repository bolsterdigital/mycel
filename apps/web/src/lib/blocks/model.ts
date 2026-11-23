// The render model (brief #8c § 1): one published locale of one published revision, with every
// tenant reference already resolved, as plain data. The components and the Markdown renderer are
// functions of this model and nothing else: no database access, no `{ nl, en }` maps, no paths
// of restricted media or unpublished items. #11 builds the same model from an authorised
// revision for its preview; #19 adds the reader's view.
//
// Paths in the model are site-root paths (`/media/<id>/w640.avif`, `/<slug>`) or external URLs.
// `base` is the prefix of the current address form (`''` on a hostname, `/probe` in the dev
// path form); HTML prepends it, Markdown makes the path absolute through `siteUrl`. Rejected:
// storing finished hrefs, which would make the Markdown of a dev request carry the dev prefix.

import { bunnyStreamVideoUrl, type EmbedId } from '@mycel/core';
import type {
  DocumentHeader,
  CampaignCardReason,
  CampaignKind,
  CampaignPhase,
  PublicPersonCard,
  CreditKind,
  FormField,
  MediaCredit,
  ProofChallenge,
  RichTextDoc,
} from '@mycel/core';

/** UI text that does not come from the document (ADR 007), resolved for the model's locale. */
export interface BlockCopy {
  callout: { info: string; note: string; warning: string };
  /** What a scrolling row of images is called for assistive technology. */
  galleryRow: string;
  audioDownload: string;
  audioTranscript: string;
  /** Per kind of image, `{name}` filled by the renderer: 'Foto: {name}'. */
  credit: Record<CreditKind, string>;
  /** `{provider}` filled by the renderer. */
  videoOn: string;
  /** The play button of a placed player; `{title}` and `{provider}` filled by the renderer. */
  videoPlay: string;
  videoCredit: string;
  videoYouTube: string;
  footnotes: string;
  footnoteBack: string;
  /** The cover header's arrow down to the content. */
  toContent: string;
  /** The line in a timeline between what happened and what is still to come (MY-278). */
  timelineNow: string;
  /** The words of the lightbox; `count` holds `{n}` and `{total}`. */
  lightbox: {
    enlarge: string;
    dialog: string;
    close: string;
    previous: string;
    next: string;
    zoom: string;
    count: string;
  };
  honeypotLabel: string;
  summaryTitle: string;
  /** Where a membership form's tier sells nothing now (MY-254 PR 4). */
  membershipUnavailable: string;
  /** A campaign card's and a closed campaign form's words (ADR 033 rule 4). */
  campaign: {
    kind: Record<CampaignKind, string>;
    phase: Record<CampaignPhase, string>;
    /** What the counter counts, per kind: 'Handtekeningen'. */
    unit: Record<CampaignKind, string>;
    /** `{target}`: 'Doel: 5.000'. */
    goal: string;
    /** Nothing counted yet, per kind: 'Nog geen handtekeningen'. */
    none: Record<CampaignKind, string>;
    /** `{date}`: a campaign that opens on a known day. */
    opensOn: string;
    /** The action column's heading on a landing page outside open participation. */
    heading: Record<'upcoming' | 'closed', string>;
    /** The button to the landing page while participation is open, per kind. */
    act: Record<CampaignKind, string>;
    /** The button to the landing page otherwise. */
    more: string;
    /** The buttons under a full card's shortened campaign text (campaign-body.js). */
    readMore: string;
    readLess: string;
    /** Where a card's text leaves blocks out: the link to the rest on the landing page. */
    readOn: string;
    /** In place of a form whose campaign does not accept participation now. */
    notOpen: Record<'upcoming' | 'closed', string>;
  };
  /** The page links under an overview with an archive. */
  overview: { older: string; newer: string; label: string; restricted: string };
}

export interface RenderImage {
  /** `''` for a decorative image. */
  alt: string;
  width: number;
  height: number;
  /** A WebP variant of moderate width, for browsers that ignore `srcset`. */
  src: string;
  /** WebP widths for the `<img>`, AVIF widths for the `<source>`; `''` when there are none. */
  srcset: string;
  avifSrcset: string;
  caption: string | null;
  /**
   * Who made it and the licence it is used under: its words in this locale and the
   * licence text it links to (null for a statement such as "All rights reserved").
   */
  credit:
    | (MediaCredit & {
        photographerHref?: string | null;
        licence?: { label: string; href: string | null } | null;
      })
    | null;
  /** The focal point quantised to steps of 10 % (0..10), rendered as classes under the CSP. */
  focal: { x: number; y: number };
  /** The widest public WebP variant, which the lightbox opens; null without a variant. */
  large: { src: string; width: number; height: number } | null;
}

/** An article's line under its header; each part is absent when the article has none. */
export interface RenderMeta {
  date: { iso: string; label: string } | null;
  byline: string | null;
  /** Structured public links; previews can keep the plain-text byline. */
  bylineParts?: { text: string; href?: string }[];
  section: string | null;
}

/**
 * An article's corrections after its body (ADR 012 rule 1): the heading and each dated note in
 * this locale, in the order the editor added them. Absent where there are none to show.
 */
export interface RenderCorrections {
  title: string;
  entries: { date: { iso: string; label: string }; text: string }[];
}

/**
 * An event page's when and where under its lead, with the words of its labels: `iso` is
 * the start as an HTML local date and time, in the site's zone like the label.
 */
export interface RenderEvent {
  when: { iso: string; label: string; term: string };
  where: { text: string; term: string } | null;
  online: { href: string; text: string; term: string } | null;
}

/** The lead and hero image between an item's title and its blocks (#86). */
export interface RenderIntro {
  lead: string | null;
  hero: RenderImage | null;
  /**
   * `cover` and `split` only with a hero image to fill them with (brief #105 rule 8); `split` is a
   * page's (ADR 025, amended 2026-11-23).
   */
  header: DocumentHeader;
  /** The split header's one button; absent without one or when its target is unavailable. */
  action?: RenderAction | null;
  meta: RenderMeta | null;
  /** Absent on everything but an event page with a start. */
  event?: RenderEvent | null;
}

export interface RenderAction {
  label: string;
  /** A site-root path (`/x`) or an external URL. */
  href: string;
}

export interface RenderForm {
  formId: string;
  /**
   * A membership form (MY-254 PR 4): the tier's prices to choose from, posted as
   * `membership-interval`; null when the tier sells nothing now, absent on every other form.
   */
  membership?: { legend: string; options: { value: string; label: string }[] } | null;
  startedToken: string;
  /** The ALTCHA challenge the form script solves (`forms/proof.ts`); fresh per render. */
  proof: ProofChallenge;
  submitLabel: string;
  /** Shown on the page's thank-you page after a successful post. */
  thankYou: string;
  version?: string;
  conditionalHelp?: string;
  fields: {
    id?: string;
    baseRequired?: boolean;
    pattern?: string;
    activeWhen?: FormField['activeWhen'];
    requiredWhen?: FormField['requiredWhen'];
    name: string;
    type: FormField['type'];
    label: string;
    required: boolean;
    help?: string;
    conditional?: boolean;
    options?: { value: string; label: string }[];
    value?: string;
    min?: number;
    max?: number;
    maxLength?: number;
    /** An amount field's choices, with their label in the page's locale ("€ 25"). */
    presets?: { value: string; label: string }[];
    /** With presets: the label of the visitor's own amount, posted as `<name>-other`; absent when not offered. */
    otherLabel?: string;
    /** A gift's choice of once, monthly or yearly, posted as `<name>-interval` (MY-254). */
    intervals?: { legend: string; options: { value: string; label: string }[] };
  }[];
}

/**
 * A campaign as a card or a closed form shows it (ADR 033 rule 4): only aggregates, never a
 * participant. `revisionId` is the landing page's published revision; the host page's ETag
 * digests it with the phase and the count (rule 6).
 */
export interface RenderCampaign {
  campaignId: string;
  kind: CampaignKind;
  phase: CampaignPhase;
  /** The landing page's site-root path in this locale. */
  href: string;
  title: string;
  summary: string | null;
  /** Decorative: the heading beside it names the campaign. */
  image: RenderImage | null;
  /** A fundraiser counts `raised` (minor units) against a target in minor units. */
  counter: {
    participants: number;
    raised: { amount: number; currency: string } | null;
    target: number | null;
  } | null;
  /** Not open yet with a known opening: the date in the site's words; else null. */
  opens: { iso: string; label: string } | null;
  revisionId: string;
}

type Width = 'content' | 'wide' | 'full';
type Align = 'start' | 'center' | 'end';

export type RenderBlock = { id: string } & (
  | { type: 'heading'; text: string }
  | {
      type: 'people-grid';
      columns: '2' | '3' | '4';
      showRole: boolean;
      showBio: boolean;
      showContact: boolean;
      people: (PublicPersonCard & { image: RenderImage | null; href: string | null })[];
    }
  | {
      type: 'rich-text';
      doc: RichTextDoc;
      /** Set on the heading split off above a float (`float-order.ts`): the block it came from. */
      sourceId?: string;
    }
  | { type: 'paywall' }
  | {
      type: 'image';
      layout: 'content' | 'wide' | 'full' | 'float-left' | 'float-right';
      image: RenderImage | null;
    }
  | {
      type: 'hero';
      variant: 'minimal' | 'cover' | 'split';
      title: string;
      body: string | null;
      image: RenderImage | null;
      actions: RenderAction[];
      width: Width;
      align: Align;
    }
  | {
      type: 'cta';
      variant: 'band' | 'card';
      title: string;
      body: string | null;
      actions: RenderAction[];
      width: Width;
      align: Align;
    }
  | {
      type: 'cards';
      accent: 'none' | 'bar' | 'filled';
      width: Width;
      cards: { title: string; body: string | null; actions: RenderAction[] }[];
    }
  | {
      type: 'file-download';
      title: string | null;
      body: string | null;
      /** Only what a visitor may fetch; a restricted, deleted or failed file is left out. */
      files: { label: string; href: string; meta: string }[];
    }
  | {
      type: 'audio';
      title: string;
      /** Null when a visitor may not fetch it: restricted, deleted or failed. */
      file: { href: string; meta: string } | null;
      transcript: string | null;
    }
  | {
      type: 'gallery';
      variant: 'grid' | 'row';
      width: Width;
      /** Only what a visitor may see; a restricted, deleted or failed image is left out. */
      images: RenderImage[];
    }
  | {
      type: 'timeline';
      title: string | null;
      /** In the order they are shown; the date is ISO, its label is in the model's locale. */
      events: {
        date: string;
        dateLabel: string;
        /** Reached on the site's clock when the page was rendered (today counts), or still to come. */
        when: 'past' | 'future';
        title: string;
        body: string | null;
        actions: RenderAction[];
      }[];
    }
  | {
      type: 'callout';
      variant: 'info' | 'note' | 'warning';
      title: string | null;
      body: RichTextDoc;
    }
  | {
      type: 'faq';
      variant: 'list' | 'accordion';
      width: Width;
      title: string | null;
      entries: { question: string; answer: RichTextDoc }[];
    }
  | {
      type: 'quote';
      variant: 'blockquote' | 'pullquote';
      width: Width;
      text: string;
      name: string;
      role: string | null;
      source: string | null;
      url: string | null;
    }
  | {
      type: 'video-embed';
      provider: EmbedId;
      url: string;
      /** The player's address, used only where the site placed that provider (`embeds.ts`). */
      player: string;
      title: string;
      caption: string | null;
      width: Width;
      poster: RenderImage | null;
      duration: number | null;
      maker: { label: string; href: string | null } | null;
      licence: { label: string; href: string | null } | null;
      youtube: string | null;
      page: string | null;
    }
  | {
      type: 'form';
      variant: 'default' | 'card';
      width: Width;
      form: RenderForm | null;
      /**
       * The campaign the form is bound to, while it does not accept participation: the block then
       * shows where it stands instead of its fields (ADR 033 rule 2). Null otherwise.
       */
      campaign?: RenderCampaign | null;
      /**
       * Why the public page shows no form here, while this model keeps it: set only for the admin
       * preview (`diagnose`), where an editor checks the form before participation opens.
       */
      diagnosis?: CampaignCardReason | 'upcoming' | 'closed';
    }
  | {
      type: 'overview';
      layout: 'cards' | 'list';
      width: Width;
      entries: {
        id: string;
        /** Site-root path of the item in this locale. */
        href: string;
        title: string;
        summary: string | null;
        /**
         * An event's when as its header writes it (wall clock, `YYYY-MM-DDTHH:mm`); else the
         * first publication in this locale, as a date in the site's time zone.
         */
        date: { iso: string; label: string };
        /** An event's place, or the host of its online address; null for anything else. */
        place: string | null;
        /** Decorative: the title beside it names the item. */
        image: RenderImage | null;
        pinned: boolean;
        /** For members or a tier: the card names it, and its link leads to the teaser. */
        restricted: boolean;
        /** In a campaign index (MY-292): kind, phase now and the public count; else null. */
        campaign: Pick<RenderCampaign, 'kind' | 'phase' | 'counter'> | null;
        revisionId: string;
      }[];
      /** Site-root paths of the neighbouring pages; only with `archive` on. */
      older: string | null;
      newer: string | null;
    }
  | {
      type: 'campaign-card';
      variant: 'compact' | 'full';
      width: Width;
      /** Null: the campaign is not available here, and the page shows nothing for it. */
      campaign: RenderCampaign | null;
      /** The campaign's form, on a `full` card while participation is open; else null. */
      form: RenderForm | null;
      /**
       * On a `full` card, the campaign's text from the same landing revision (ADR 038 rule 4), its
       * ids prefixed with the card's; `more` when the page holds more than the card shows, `open`
       * when it is short enough to show without `<details>`. Null on compact or without text.
       */
      body: { blocks: RenderBlock[]; more: boolean; open: boolean } | null;
      /** Why `campaign` is null; set only for the admin preview (`diagnose`), never publicly. */
      diagnosis?: CampaignCardReason;
    }
);

/** What the page's form action returned after a failed post, if anything. */
export interface FormState {
  formId: string;
  errors: { field: string; message: string }[];
  message: string | null;
  values?: Record<string, string | string[]> | undefined;
}

/**
 * The campaign of a bound landing page as its campaign layout shows it (ADR 038 rules 2, 5-7):
 * the page itself supplies title, lead and header image. Absent on every other page.
 */
export interface RenderLanding {
  kind: CampaignKind;
  phase: CampaignPhase;
  /** Not open yet with a known opening: the date in the site's words; else null. */
  opens: RenderCampaign['opens'];
  counter: RenderCampaign['counter'];
  /** The campaign's form while participation is open (in the preview: always, with `diagnosis`). */
  form: RenderForm | null;
  /** Why the public page shows no form here; the admin preview only. */
  diagnosis?: 'upcoming' | 'closed';
}

export interface RenderModel {
  locale: string;
  title: string;
  /** Set when this item is a campaign's landing page: it renders in the campaign layout. */
  campaign?: RenderLanding | null;
  /** The address-form prefix HTML puts in front of a site-root path. */
  base: string;
  blocks: RenderBlock[];
  /** Item id to its public site-root path, or null: published in this locale and public, or not. */
  links: Record<string, string | null>;
  copy: BlockCopy;
  /**
   * What a card without an image shows in its image area (MY-277): the site's logo, else the
   * first letter of its name, on the primary pair. Absent where a caller has no site (fixtures),
   * and such a card has no image area.
   */
  placeholder?: CardPlaceholder;
}

/** The decorative stand-in for a card's missing image: the site's logo or its initial. */
export interface CardPlaceholder {
  logo: { src: string; width: number; height: number } | null;
  initial: string;
}

/** The provider's own page for a video: a plain link, no embed (brief #8c § 2). */
export function videoUrl(provider: EmbedId, videoId: string): string {
  if (provider === 'bunny-stream') return bunnyStreamVideoUrl(videoId);
  return provider === 'youtube'
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    : `https://vimeo.com/${encodeURIComponent(videoId)}`;
}

/**
 * The provider's player, without its tracking cookies: YouTube's nocookie host, Vimeo with `dnt`.
 * It starts playing, because the visitor's click on the play button is what loads it.
 */
export function videoPlayerUrl(provider: EmbedId, videoId: string): string {
  if (provider === 'bunny-stream') return `${bunnyStreamVideoUrl(videoId)}?autoplay=true`;
  const id = encodeURIComponent(videoId);
  return provider === 'youtube'
    ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`
    : `https://player.vimeo.com/video/${id}?dnt=1&autoplay=1`;
}

export const VIDEO_PROVIDER_NAMES = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  'bunny-stream': 'Bunny Stream',
} as const;
