<!-- One placed menu as a list of real anchors (ADR 036 rule 12), for the panel and the footer alike.
     A group is a native disclosure, never a link to `#` (rule 2); a link keeps its sublinks visible
     under it, because without JavaScript a second control beside the link would have to move on
     opening. The enhancement (step D2) adds that control. `openGroups` opens every group, as the
     footer does; otherwise only the branch that holds the current page is open.
     Rejected: `role=menu`, an application widget a site navigation is not (rule 12). -->
<script lang="ts">
  import { holdsCurrent, isCurrent, type ChromeLink, type ChromeNode } from './chrome.js';

  let {
    nodes,
    current = null,
    openGroups = false,
  }: { nodes: ChromeNode[]; current?: string | null; openGroups?: boolean } = $props();
</script>

{#snippet anchor(link: ChromeLink)}
  <a href={link.href} aria-current={isCurrent(link.href, current) ? 'page' : undefined}
    >{link.label}</a
  >
{/snippet}

{#snippet sublinks(children: ChromeLink[])}
  <ul>
    {#each children as child, i (i)}<li>{@render anchor(child)}</li>{/each}
  </ul>
{/snippet}

<ul class="site-tree">
  {#each nodes as node, i (i)}
    <li>
      {#if node.kind === 'link'}
        {@render anchor(node)}
        {#if node.children.length}{@render sublinks(node.children)}{/if}
      {:else}
        <details class="site-group" open={openGroups || holdsCurrent(node, current)}>
          <summary>{node.label}</summary>
          {@render sublinks(node.children)}
        </details>
      {/if}
    </li>
  {/each}
</ul>
