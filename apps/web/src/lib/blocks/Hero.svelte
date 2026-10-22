<!-- `cover` puts the text on an opaque theme surface over the image, `split` beside it, `minimal`
     has no image; text never sits straight on a photo (brief #8c § 2). -->
<script lang="ts">
  import { BLOCK_DEPTH, headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import Actions from './Actions.svelte';
  import Picture from './Picture.svelte';

  let { block, model }: { block: Extract<RenderBlock, { type: 'hero' }>; model: RenderModel } =
    $props();
</script>

<section class="block hero hero-{block.variant} width-{block.width} align-{block.align}">
  {#if block.image}
    <div class="hero-media">
      <Picture
        image={block.image}
        base={model.base}
        sizes={block.variant === 'split' ? '(min-width: 48rem) 50vw, 100vw' : '100vw'}
        eager
      />
    </div>
  {/if}
  <div class="hero-text">
    <svelte:element this={headingTag(BLOCK_DEPTH)}>{block.title}</svelte:element>
    {#if block.body}<p>{block.body}</p>{/if}
    <Actions actions={block.actions} base={model.base} />
  </div>
</section>
