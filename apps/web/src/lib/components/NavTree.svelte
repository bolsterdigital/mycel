<!-- One placed menu as a list of real anchors (ADR 036 rule 12), for the panel and the footer alike.
     A group is a native disclosure, never a link to `#` (rule 2); a link keeps its sublinks visible
     under it, because without JavaScript a second control beside the link would have to move on
     opening. With `toggleLabel` (the panel) that control is rendered `hidden` beside the link, and
     the enhancement (`static/_site/navigation.js`) shows it and folds the sublinks behind it, the
     branch of the current page open. `openGroups` opens every group, as the footer does; otherwise
     only the branch that holds the current page is open.
     Rejected: `role=menu`, an application widget a site navigation is not (rule 12). -->
<script lang="ts">
  import { holdsCurrent, isCurrent, type ChromeLink, type ChromeNode } from './chrome.js';

  let {
    nodes,
    current = null,
    openGroups = false,
    toggleLabel,
    idPrefix = 'site-tree',
  }: {
    nodes: ChromeNode[];
    current?: string | null;
    openGroups?: boolean;
    /** The words of a link's sublink button, from its label; without it, no button. */
    toggleLabel?: (label: string) => string;
    idPrefix?: string;
  } = $props();
</script>

{#snippet anchor(link: ChromeLink)}
  <a href={link.href} aria-current={isCurrent(link.href, current) ? 'page' : undefined}
    >{link.label}</a
  >
{/snippet}

{#snippet sublinks(children: ChromeLink[], id?: string)}
  <ul {id}>
    {#each children as child, i (i)}<li>{@render anchor(child)}</li>{/each}
  </ul>
{/snippet}

<ul class="site-tree">
  {#each nodes as node, i (i)}
    <li>
      {#if node.kind === 'link'}
        {#if node.children.length && toggleLabel}
          <div class="site-tree-link">
            {@render anchor(node)}<button
              type="button"
              class="site-sub-toggle"
              data-site-toggle
              hidden
              aria-expanded={holdsCurrent(node, current)}
              aria-controls="{idPrefix}-{i}"
              ><span class="site-hidden-word">{toggleLabel(node.label)}</span></button
            >
          </div>
          {@render sublinks(node.children, `${idPrefix}-${i}`)}
        {:else}
          {@render anchor(node)}
          {#if node.children.length}{@render sublinks(node.children)}{/if}
        {/if}
      {:else}
        <details class="site-group" open={openGroups || holdsCurrent(node, current)}>
          <summary>{node.label}</summary>
          {@render sublinks(node.children)}
        </details>
      {/if}
    </li>
  {/each}
</ul>
