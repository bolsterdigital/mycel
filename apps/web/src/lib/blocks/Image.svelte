<script lang="ts">
  import type { RenderImage, RenderModel } from './model.js';
  import Credit from './Credit.svelte';
  import Picture from './Picture.svelte';
  import { LIGHTBOX_SCRIPT, largerImage, lightboxAttributes } from './lightbox.js';
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

  const large = $derived(largerImage(image, layout));
</script>

<svelte:head>
  {#if large}<script type="module" src={LIGHTBOX_SCRIPT}></script>{/if}
</svelte:head>

<figure
  class="block image layout-{layout}"
  {...large ? lightboxAttributes(model.copy.lightbox) : {}}
>
  <Picture
    {image}
    base={model.base}
    sizes={IMAGE_SIZES[layout]}
    {eager}
    {large}
    enlarge={model.copy.lightbox.enlarge}
  />
  {#if image.caption || image.credit}
    <figcaption>
      {#if image.caption}{image.caption}{/if}
      {#if image.credit}<Credit credit={image.credit} words={model.copy.credit} />{/if}
    </figcaption>
  {/if}
</figure>
