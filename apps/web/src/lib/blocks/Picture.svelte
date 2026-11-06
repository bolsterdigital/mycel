<!-- One image: <picture> with an AVIF source and WebP in the <img>, intrinsic width and height
     against layout shift (ADR 009 rule 4), the focal point as classes because a style attribute
     falls under the CSP. Lazy unless it is the first image of the page or a hero's. With `large`
     the picture is a plain link to that file: the lightbox without JavaScript, and what
     `static/_image/lightbox.js` opens with it; `enlarge` is the hidden word that tells a screen
     reader the link shows the image larger. -->
<script lang="ts">
  import type { RenderImage } from './model.js';
  import { withBase } from './rich-text.js';

  let {
    image,
    base,
    sizes,
    eager = false,
    large = null,
    enlarge = '',
  }: {
    image: RenderImage;
    base: string;
    sizes: string;
    eager?: boolean;
    large?: { src: string; width: number; height: number } | null;
    enlarge?: string;
  } = $props();

  const set = (s: string) =>
    s
      .split(', ')
      .filter(Boolean)
      .map((part) => withBase(base, part))
      .join(', ');
</script>

{#snippet picture()}
  <picture>
    {#if image.avifSrcset}<source type="image/avif" srcset={set(image.avifSrcset)} {sizes} />{/if}
    <img
      src={withBase(base, image.src)}
      srcset={set(image.srcset) || undefined}
      sizes={image.srcset ? sizes : undefined}
      alt={image.alt}
      width={image.width}
      height={image.height}
      loading={eager ? undefined : 'lazy'}
      fetchpriority={eager ? 'high' : undefined}
      decoding={eager ? undefined : 'async'}
      class="fx-{image.focal.x} fy-{image.focal.y}"
    />
  </picture>
{/snippet}

{#if large}
  <a
    class="enlarge"
    href={withBase(base, large.src)}
    data-width={large.width}
    data-height={large.height}>{@render picture()}<span class="enlarge-word"> ({enlarge})</span></a
  >
{:else}
  {@render picture()}
{/if}
