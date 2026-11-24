<!-- Plain permalinks keep the conversation reachable without an embed or client-side code. -->
<script lang="ts">
  import { headingTag } from './headings.js';
  import type { RenderBlock, RenderModel } from './model.js';

  let {
    block,
    model,
    anchor,
    depth,
  }: {
    block: Extract<RenderBlock, { type: 'social-conversation' }>;
    model: RenderModel;
    anchor?: string;
    depth: number;
  } = $props();
</script>

<section id={anchor} class="block social-conversation">
  <svelte:element this={headingTag(depth + 1)}>{model.copy.socialConversation}</svelte:element>
  <ul>
    {#each block.links as { network, href } (network)}
      <li><a {href}>{network}</a></li>
    {/each}
  </ul>
</section>

<style>
  @layer components {
    ul {
      margin-block: 0;
      padding-inline-start: 1.25em;
    }

    a {
      display: inline-flex;
      align-items: center;
      min-block-size: 44px;
      min-inline-size: 44px;
      overflow-wrap: anywhere;
    }
  }
</style>
