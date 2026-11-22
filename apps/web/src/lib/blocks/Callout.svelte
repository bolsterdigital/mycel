<!-- The variant's meaning is a visible label from the UI catalogue, not colour alone. -->
<script lang="ts">
  import { headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';
  import RichText from './RichText.svelte';

  let {
    block,
    model,
    anchor,
    depth,
  }: {
    block: Extract<RenderBlock, { type: 'callout' }>;
    model: RenderModel;
    anchor?: string;
    depth: number;
  } = $props();
</script>

<div id={anchor} class="block callout callout-{block.variant}" role="note">
  <p class="callout-label">{model.copy.callout[block.variant]}</p>
  {#if block.title}<svelte:element this={headingTag(depth + 1)}>{block.title}</svelte:element>{/if}
  <RichText
    doc={block.body}
    {model}
    depth={block.title ? depth + 1 : depth}
    idPrefix={block.id}
    class="callout-body"
  />
</div>
