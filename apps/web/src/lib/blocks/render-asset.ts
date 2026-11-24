// Images and files use the same delivery boundary. Resolve srcset, crop and attribution before rendering.
import {
  LICENCE_URLS,
  placementFor,
  type ImagePlacement,
  type MediaLicence,
  type MediaView,
} from '@mycel/core';
import { framingAttributes } from './framing.js';
import { formatBytes } from '../admin/format.js';
import { ui } from '../../i18n/index.js';
import type { RenderImage } from './model.js';

/** The width `src` aims for: enough for a content column, small enough for an old browser. */
const FALLBACK_WIDTH = 960;

/** A licence in this locale's words and its link; `other` is named by its own text. */
function renderLicence(licence: MediaLicence | null, locale: string) {
  if (!licence) return null;
  const label = licence.text ?? ui(locale)(`block.licence.${licence.code}`);
  return { label, href: LICENCE_URLS[licence.code] };
}

export function renderAssetImage(
  asset: MediaView | null,
  use: {
    decorative: boolean;
    alt: Partial<Record<string, string>> | null;
    caption?: Partial<Record<string, string>> | undefined;
    credit?: NonNullable<RenderImage['credit']> | undefined;
    placement?: ImagePlacement | undefined;
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
    framing: framingAttributes(placementFor(use.placement, asset.id), asset.focal),
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
export function renderFile(
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
