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

import type {
  ArticleHeader,
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
  footnotes: string;
  footnoteBack: string;
  /** The cover header's arrow down to the content. */
  toContent: string;
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
  credit: (MediaCredit & { photographerHref?: string | null }) | null;
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

/** The lead and hero image between an item's title and its blocks (#86). */
export interface RenderIntro {
  lead: string | null;
  hero: RenderImage | null;
  /** `cover` only with a hero image to cover the screen with (brief #105 rule 8). */
  header: ArticleHeader;
  meta: RenderMeta | null;
}

export interface RenderAction {
  label: string;
  /** A site-root path (`/x`) or an external URL. */
  href: string;
}

export interface RenderForm {
  formId: string;
  startedToken: string;
  /** The ALTCHA challenge the form script solves (`forms/proof.ts`); fresh per render. */
  proof: ProofChallenge;
  submitLabel: string;
  /** Shown on the page's thank-you page after a successful post. */
  thankYou: string;
  version?: string;
  conditionalHelp?: string;
  fields: {
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
  }[];
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
      provider: 'youtube' | 'vimeo';
      url: string;
      title: string;
      caption: string | null;
      width: Width;
    }
  | { type: 'form'; variant: 'default' | 'card'; width: Width; form: RenderForm | null }
);

/** What the page's form action returned after a failed post, if anything. */
export interface FormState {
  formId: string;
  errors: { field: string; message: string }[];
  message: string | null;
  values?: Record<string, string | string[]> | undefined;
}

export interface RenderModel {
  locale: string;
  title: string;
  /** The address-form prefix HTML puts in front of a site-root path. */
  base: string;
  blocks: RenderBlock[];
  /** Item id to its public site-root path, or null: published in this locale and public, or not. */
  links: Record<string, string | null>;
  copy: BlockCopy;
}

/** The provider's own page for a video: a plain link, no embed (brief #8c § 2). */
export function videoUrl(provider: 'youtube' | 'vimeo', videoId: string): string {
  return provider === 'youtube'
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    : `https://vimeo.com/${encodeURIComponent(videoId)}`;
}

export const VIDEO_PROVIDER_NAMES = { youtube: 'YouTube', vimeo: 'Vimeo' } as const;
