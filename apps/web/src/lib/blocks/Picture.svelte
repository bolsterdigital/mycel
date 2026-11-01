<!-- One image: <picture> with an AVIF source and WebP in the <img>, intrinsic width and height
     against layout shift (ADR 009 rule 4), the focal point as classes because a style attribute
     falls under the CSP. Lazy unless it is the first image of the page or a hero's. -->
<script lang="ts">
  import type { RenderImage } from './model.js';
  import { withBase } from './rich-text.js';

  let {
    image,
    base,
    sizes,
    eager = false,
  }: { image: RenderImage; base: string; sizes: string; eager?: boolean } = $props();

  const set = (s: string) =>
    s
      .split(', ')
      .filter(Boolean)
      .map((part) => withBase(base, part))
      .join(', ');
</script>

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
