<!-- Plain permalinks keep the conversation reachable without an embed or client-side code. -->
<script lang="ts">
  import { plural, ui } from '../../i18n/index.js';
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

  const t = $derived(ui(model.locale));
  const number = $derived(new Intl.NumberFormat(model.locale));
</script>

<section id={anchor} class="block social-conversation">
  <svelte:element this={headingTag(depth + 1)}>{model.copy.socialConversation}</svelte:element>
  <ul>
    {#each block.links as { network, href, counts } (network)}
      <li>
        <a {href}>{network}</a>
        {#if counts?.replies !== undefined}
          <span
            >{plural(t, 'block.socialConversation.replies', counts.replies, {
              n: number.format(counts.replies),
            })}</span
          >
        {/if}
        {#if counts?.reposts !== undefined}
          <span
            >{plural(t, 'block.socialConversation.reposts', counts.reposts, {
              n: number.format(counts.reposts),
            })}</span
          >
        {/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  @layer components {
    ul {
      margin-block: 0;
      padding-inline-start: 1.25em;
    }

    span {
      display: inline-block;
      margin-inline-end: 0.5em;
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
