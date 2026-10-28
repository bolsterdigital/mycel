<!-- A short status label (draft, published, restricted). The word carries the meaning; the
     colour only repeats it (WCAG 1.4.1). -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    tone = 'neutral',
    children,
  }: {
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
    children: Snippet;
  } = $props();
</script>

<span class="ui-badge {tone}">{@render children()}</span>
