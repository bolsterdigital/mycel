<script lang="ts">
  import '#lib/theme/base.css';
  import SiteFooter from '#lib/components/SiteFooter.svelte';
  import SiteHeader from '#lib/components/SiteHeader.svelte';
  import { languageLinks } from '#lib/public/language-links.js';
  import { page } from '$app/state';
  import { ui } from '../../i18n/index.js';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
  const t = $derived(ui(data.locale));
  // The menus mark the page they lead to (`aria-current`), and open its branch in the panel.
  const current = $derived(page.url.pathname);
  const languages = $derived(
    page.data.navigationLanguages ??
      (page.data.head?.alternates
        ? languageLinks(page.data.head.alternates)
        : (data.chrome?.languages ?? []))
  );
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
  {#each data.feeds as feed (feed.href)}
    <link rel="alternate" type={feed.type} href={feed.href} title={feed.title} />
  {/each}
  {#if data.siteHead}
    <link rel="manifest" href={data.siteHead.manifest} />
    {#if data.siteHead.tdmReservation}<meta name="tdm-reservation" content="1" />{/if}
  {/if}
  {#if data.chrome?.logo}
    <link rel="icon" href={data.chrome.logo.src} type="image/webp" />
    {#if data.siteHead?.touchIcon}<link
        rel="apple-touch-icon"
        href={data.siteHead.touchIcon}
      />{/if}
  {:else}
    <link rel="icon" href="data:," />
  {/if}
</svelte:head>

{#if data.chrome}
  <a class="public-skip" href="#public-main">{t('public.skip')}</a>
  <SiteHeader chrome={data.chrome} locale={data.locale} {current} {languages} />
{/if}
<div id="public-main">{@render children()}</div>
{#if data.chrome}<SiteFooter
    chrome={data.chrome}
    credit={data.credit}
    locale={data.locale}
    {current}
    consentHref={page.data.consent?.choiceHref ?? null}
  />{/if}
