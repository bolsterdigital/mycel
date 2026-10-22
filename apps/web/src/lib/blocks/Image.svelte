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

  const SIZES = {
    content: '(min-width: 48rem) 44rem, 100vw',
    wide: '(min-width: 72rem) 68rem, 100vw',
    full: '100vw',
    'float-left': '(min-width: 48rem) 20rem, 100vw',
    'float-right': '(min-width: 48rem) 20rem, 100vw',
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
