<!-- Sections of one screen that a script may show as tabs (brief edit-screen § 6). The server
     renders every section below the other, each with its heading, so without JavaScript nothing
     is out of reach. The tablist is in the markup but `hidden`: static/_admin/tabs.js (#66 PR 3),
     loaded by the screen that wants tabs, unhides it, gives the sections role="tabpanel" and
     shows one at a time, with the arrow keys of the ARIA tabs pattern and the tab in the hash. Rejected: links to `?tab=` (a page load per tab, and a
     form split over URLs loses what was typed) and radio buttons with :checked CSS (a form
     control for navigation, announced as a choice). -->
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
  <div class="ui-tabs-list" role="tablist" aria-label={label} hidden>
    {#each tabs as tab, i (tab.id)}
      <button
        type="button"
        role="tab"
        id="{id}-tab-{tab.id}"
        aria-controls="{id}-{tab.id}"
        aria-selected={i === 0 ? 'true' : 'false'}
        tabindex={i === 0 ? 0 : -1}>{tab.label}</button
      >
    {/each}
  </div>
  {#each tabs as tab (tab.id)}
    <section class="ui-tabs-panel" id="{id}-{tab.id}" aria-labelledby="{id}-{tab.id}-title">
      <svelte:element this={`h${level}`} class="ui-tabs-title" id="{id}-{tab.id}-title"
        >{tab.label}</svelte:element
      >
      {@render tab.content()}
    </section>
  {/each}
</div>
