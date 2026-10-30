<!-- One card of the dashboard: a heading and what it shows. Without content it shows its empty
     state, one line saying the widget comes later, so the dashboard has its shape before its data
     (decision Jaap 2026-10-29, brief edit-screen § 4). Each widget is a region named by its
     heading, so a screen reader lists the dashboard's parts. Rejected: Card, whose stretched
     link, media slot and footer a widget does not use, and whose h3 sits under no h2 here. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ui } from '../../../../i18n/index.js';

  let {
    id,
    title,
    locale,
    level = 2,
    children,
  }: {
    id: string;
    title: string;
    locale: string;
    level?: 2 | 3;
    children?: Snippet | undefined;
  } = $props();
  const t = $derived(ui(locale));
</script>

<section class={['ui-widget', !children && 'empty']} aria-labelledby={id}>
  <svelte:element this={`h${level}`} class="ui-widget-title" {id}>{title}</svelte:element>
  {#if children}
    {@render children()}
  {:else}
    <p class="ui-widget-later">{t('admin.ui.widget.later')}</p>
  {/if}
</section>
