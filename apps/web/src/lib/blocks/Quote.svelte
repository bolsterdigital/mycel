<script lang="ts">
  import type { RenderBlock } from './model.js';

  let { block }: { block: Extract<RenderBlock, { type: 'quote' }> } = $props();
</script>

<figure class="block quote quote-{block.variant} width-{block.width}">
  <blockquote><p>{block.text}</p></blockquote>
  <figcaption>
    {block.name}{#if block.role}, {block.role}{/if}{#if block.source}, <cite
        >{#if block.url}<a href={block.url}>{block.source}</a>{:else}{block.source}{/if}</cite
      >{:else if block.url}, <a href={block.url}>{block.url}</a>{/if}
  </figcaption>
</figure>
