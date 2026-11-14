<script lang="ts">
  import '#lib/theme/base.css';
  import SiteFooter from '#lib/components/SiteFooter.svelte';
  import SiteHeader from '#lib/components/SiteHeader.svelte';
  import { ui } from '../../i18n/index.js';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
  const t = $derived(ui(data.locale));
</script>

<svelte:head>
  {#if data.theme}
    {#each data.theme.preload as font (font)}
      <link rel="preload" href={font} as="font" type="font/woff2" crossorigin="anonymous" />
    {/each}
    <link rel="stylesheet" href={data.theme.href} />
    <meta
      name="theme-color"
      media="(prefers-color-scheme: light)"
      content={data.theme.colors.light}
    />
    <meta
      name="theme-color"
      media="(prefers-color-scheme: dark)"
      content={data.theme.colors.dark}
    />
    <meta name="color-scheme" content="light dark" />
  {/if}
  {#if data.chrome?.logo}
    <link rel="icon" href={data.chrome.logo.src} type="image/webp" />
  {/if}
</svelte:head>

{#if data.chrome}
  <a class="public-skip" href="#public-main">{t('public.skip')}</a>
  <SiteHeader chrome={data.chrome} locale={data.locale} />
{/if}
<div id="public-main">{@render children()}</div>
{#if data.chrome}<SiteFooter chrome={data.chrome} credit={data.credit} locale={data.locale} />{/if}
