<!-- The variant's meaning is a visible label from the UI catalogue, not colour alone. -->
<script lang="ts">
  import { BLOCK_DEPTH, headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import RichText from './RichText.svelte';

  let { block, model }: { block: Extract<RenderBlock, { type: 'callout' }>; model: RenderModel } =
    $props();
</script>

<div class="block callout callout-{block.variant}" role="note">
  <p class="callout-label">{model.copy.callout[block.variant]}</p>
  {#if block.title}<svelte:element this={headingTag(BLOCK_DEPTH)}>{block.title}</svelte:element
    >{/if}
  <RichText
    doc={block.body}
    {model}
    depth={block.title ? BLOCK_DEPTH : BLOCK_DEPTH - 1}
    idPrefix={block.id}
    class="callout-body"
  />
</div>
