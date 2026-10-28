<!-- The settings pattern (brief #56 § B): the page header, sub-navigation per subject and the
     sections of the current subject, each a SettingsSection with its own form and save. A subject
     is a URL of its own, so the sub-navigation works without JavaScript. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import PageHeader from './PageHeader.svelte';
  import SubNav from './SubNav.svelte';

  type Crumb = { label: string; href?: string | undefined };

  let {
    title,
    locale,
    breadcrumb,
    description,
    nav,
    notices,
    children,
  }: {
    title: string;
    locale: string;
    breadcrumb?: readonly Crumb[] | undefined;
    description?: string | undefined;
    nav?:
      | { label: string; items: readonly { href: string; label: string; current?: boolean }[] }
      | undefined;
    notices?: Snippet;
    children: Snippet;
  } = $props();
</script>

<main class="page admin ui-settings-page">
  <PageHeader {title} {locale} {breadcrumb} {description} />
  {#if nav}<SubNav label={nav.label} items={nav.items} />{/if}
  {#if notices}{@render notices()}{/if}
  <div class="ui-settings">{@render children()}</div>
</main>
