<!-- What a list shows when it has nothing yet: what will appear here and the one action that
     fills it. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    level = 2,
    children,
    action,
  }: { title: string; level?: 2 | 3; children?: Snippet; action?: Snippet } = $props();
</script>

<div class="ui-empty">
  <svelte:element this={`h${level}`} class="ui-empty-title">{title}</svelte:element>
  {#if children}{@render children()}{/if}
  {#if action}{@render action()}{/if}
</div>
