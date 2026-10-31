<script lang="ts">
  import type { RenderImage, RenderModel } from './model.js';
  import Credit from './Credit.svelte';
  import Picture from './Picture.svelte';
  import { IMAGE_SIZES, type ImageLayout } from './sizes.js';

  let {
    image,
    layout,
    model,
    eager,
  }: {
    image: RenderImage;
    layout: ImageLayout;
    model: RenderModel;
    eager: boolean;
  } = $props();
</script>

<figure class="block image layout-{layout}">
  <Picture {image} base={model.base} sizes={IMAGE_SIZES[layout]} {eager} />
  {#if image.caption || image.credit}
    <figcaption>
      {#if image.caption}{image.caption}{/if}
      {#if image.credit}<Credit credit={image.credit} photographer={model.copy.photographer} />{/if}
    </figcaption>
  {/if}
</figure>
