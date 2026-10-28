<!-- A notice in one of four tones. The tone is in the text and the border as well as the colour
     (WCAG 1.4.1). An error interrupts (`alert`), everything else is announced politely
     (`status`); a notice present on first load is read as page content either way. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    tone = 'info',
    title,
    children,
  }: {
    tone?: 'info' | 'success' | 'warning' | 'error';
    title?: string | undefined;
    children: Snippet;
  } = $props();
</script>

<div class="ui-notice {tone}" role={tone === 'error' ? 'alert' : 'status'}>
  {#if title}<p class="ui-notice-title">{title}</p>{/if}
  {@render children()}
</div>
