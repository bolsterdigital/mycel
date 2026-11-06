<!-- Several images in one block: a grid, or a row a visitor scrolls sideways with native snap points.
     No script, so nothing to fail; the row is a focusable region, because a keyboard has no other
     way to scroll it. Nothing left to show: nothing at all. -->
<script lang="ts">
  import type { RenderBlock, RenderModel } from './model.js';
  import Credit from './Credit.svelte';
  import Picture from './Picture.svelte';
  import { GALLERY_SIZES } from './sizes.js';

  let { block, model }: { block: Extract<RenderBlock, { type: 'gallery' }>; model: RenderModel } =
    $props();

  const sizes = $derived(
    block.variant === 'row' ? GALLERY_SIZES.row : GALLERY_SIZES.grid[block.width]
  );
</script>

{#snippet items()}
  {#each block.images as image, i (i)}
    <li>
      <figure>
        <Picture {image} base={model.base} {sizes} />
        {#if image.caption || image.credit}
          <figcaption>
            {#if image.caption}{image.caption}{/if}
            {#if image.credit}<Credit credit={image.credit} words={model.copy.credit} />{/if}
          </figcaption>
        {/if}
      </figure>
    </li>
  {/each}
{/snippet}

{#if block.images.length}
  <section class="block gallery gallery-{block.variant} width-{block.width}">
    {#if block.variant === 'row'}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrolling region must be reachable by keyboard (axe scrollable-region-focusable) -->
      <ul class="gallery-list" tabindex="0" aria-label={model.copy.galleryRow}>
        {@render items()}
      </ul>
    {:else}
      <ul class="gallery-list">
        {@render items()}
      </ul>
    {/if}
  </section>
{/if}
