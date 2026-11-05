<!-- The actions of one table row (#79, table stake 7): a row of whole buttons in a column of their
     own where the table has room, one menu under the title where it has not, the one cell a phone
     shows without scrolling the table. The route renders both and the table's width picks one in CSS
     (`.ui-table-scroll` is the container), so it works without JavaScript and follows the text
     size: at 200% the menu takes over. The row of buttons shows on hover and focus and always
     on a screen without hover. The menu opens in place: a popup would be cut off by the table's
     own scrolling. Rejected: the menu at every width (one more click for what the row is for), and
     one element restyled per width (a closed <details> hides its content in older browsers,
     whatever the CSS says). -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    menu,
    children,
  }: {
    /** The menu's label; without it, the row of buttons. */
    menu?: string | undefined;
    children: Snippet;
  } = $props();
</script>

{#if menu}
  <details class="ui-row-menu ui-fold">
    <summary class="ui-button link">{menu}</summary>
    <div class="ui-row-actions">{@render children()}</div>
  </details>
{:else}
  <div class="ui-row-actions inline">{@render children()}</div>
{/if}
