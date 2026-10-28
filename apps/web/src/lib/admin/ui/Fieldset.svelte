<!-- A group of fields under one legend, for what a visitor sees as one part of the page (skill
     cms-inrichting rule 2). `collapsed` folds it into a native <details> for settings that rarely
     change (rule 4); the legend stays the group's accessible name either way. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    legend,
    hint,
    collapsed,
    children,
  }: {
    legend: string;
    hint?: string | undefined;
    /** Undefined: always open. false/true: foldable, starting open or closed. */
    collapsed?: boolean | undefined;
    children: Snippet;
  } = $props();
</script>

{#snippet group()}
  <fieldset class="ui-fieldset">
    <legend>{legend}</legend>
    {#if hint}<p class="ui-hint">{hint}</p>{/if}
    <div class="ui-fields">{@render children()}</div>
  </fieldset>
{/snippet}

{#if collapsed === undefined}
  {@render group()}
{:else}
  <details class="ui-fold" open={!collapsed}>
    <summary>{legend}</summary>
    {@render group()}
  </details>
{/if}
