<script lang="ts">
  import type { RenderImage, RenderModel } from './model.js';
  import Credit from './Credit.svelte';
  import Picture from './Picture.svelte';

  let {
    image,
    layout,
    model,
    eager,
  }: {
    image: RenderImage;
    layout: 'content' | 'wide' | 'full' | 'float-left' | 'float-right';
    model: RenderModel;
    eager: boolean;
  } = $props();

  // A float follows the container steps of base.css (brief 46C-1): half the reading column from
  // 64rem, 40% of it from 40rem, the full width below. Measured on the probe theme at 65ch: a
  // 734 px column gives a 367 px float at 1440 px (23rem) and 293 px at 768 px (18.5rem).
  const FLOAT = '(min-width: 64rem) 23rem, (min-width: 40rem) 18.5rem, 100vw';
  const SIZES = {
    content: '(min-width: 48rem) 44rem, 100vw',
    wide: '(min-width: 72rem) 68rem, 100vw',
    full: '100vw',
    'float-left': FLOAT,
    'float-right': FLOAT,
  };
</script>

<figure class="block image layout-{layout}">
  <Picture {image} base={model.base} sizes={SIZES[layout]} {eager} />
  {#if image.caption || image.credit}
    <figcaption>
      {#if image.caption}{image.caption}{/if}
      {#if image.credit}<Credit credit={image.credit} photographer={model.copy.photographer} />{/if}
    </figcaption>
  {/if}
</figure>
