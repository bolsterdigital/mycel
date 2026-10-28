<!-- A notice in one of four tones. The tone is in the text and the border as well as the colour
     (WCAG 1.4.1). An error interrupts (`alert`), everything else is announced politely
     (`status`); a notice present on first load is read as page content either way. A standing
     note that is part of a panel rather than the answer to an action (`live={false}`) is no live
     region at all, so a screen keeps one status region for what just happened. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    tone = 'info',
    title,
    live = true,
    children,
  }: {
    tone?: 'info' | 'success' | 'warning' | 'error';
    title?: string | undefined;
    live?: boolean;
    children: Snippet;
  } = $props();
</script>

<div class="ui-notice {tone}" role={live ? (tone === 'error' ? 'alert' : 'status') : undefined}>
  {#if title}<p class="ui-notice-title">{title}</p>{/if}
  {@render children()}
</div>
