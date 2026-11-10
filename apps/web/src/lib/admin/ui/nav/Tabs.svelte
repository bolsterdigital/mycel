<!-- Fragment links select panels without leaving the form or losing input. CSS supplies the
     initial geometry; tabs.js adds ARIA tabs and keyboard navigation. Rejected: query links
     (reloads lose input), radio controls for navigation, and showing every panel until JavaScript
     arrives (the document shrinks under someone already working). -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    id,
    label,
    tabs,
    level = 2,
  }: {
    id: string;
    label: string;
    tabs: readonly { id: string; label: string; content: Snippet }[];
    level?: 2 | 3;
  } = $props();
</script>

<div class="ui-tabs" {id}>
  <nav class="ui-tabs-list" aria-label={label}>
    {#each tabs as tab (tab.id)}
      <a href="#{id}-{tab.id}" id="{id}-tab-{tab.id}" data-tab-link aria-controls="{id}-{tab.id}"
        >{tab.label}</a
      >
    {/each}
  </nav>
  {#each tabs as tab (tab.id)}
    <section class="ui-tabs-panel" id="{id}-{tab.id}" aria-labelledby="{id}-{tab.id}-title">
      <svelte:element this={`h${level}`} class="ui-tabs-title" id="{id}-{tab.id}-title"
        >{tab.label}</svelte:element
      >
      {@render tab.content()}
    </section>
  {/each}
</div>
