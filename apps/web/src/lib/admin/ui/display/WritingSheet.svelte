<!-- The writing surface belongs on its own sheet, with tools above the words. The shared
     admin surface pair supplies white in light mode and a readable dark counterpart. Rejected:
     a colour or frame local to the article route, which another writing surface would copy. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    hidden = false,
    toolbar,
    children,
  }: { hidden?: boolean; toolbar?: Snippet; children: Snippet } = $props();
</script>

<div class="ui-writing-sheet" {hidden}>
  {#if toolbar}<div class="ui-writing-sheet-toolbar">{@render toolbar()}</div>{/if}
  <div class="ui-writing-sheet-content">{@render children()}</div>
</div>
