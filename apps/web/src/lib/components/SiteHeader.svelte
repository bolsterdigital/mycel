<!-- The site header (docs/architecture/content-layout.md § Site chrome). The public layout and both
     item previews render it from one `chromeModel`, so a preview shows the site's own header,
     navigation included.

     Without JavaScript (ADR 036 rule 12) it is the logo, the first call to action, search,
     language choices and Menu, a
     native `details` whose panel holds the whole main menu and both calls to action; the bar's
     links and the second call to action are rendered but not displayed, never clipped or wrapped
     into a second row of links. The enhancement (`static/_site/navigation.js`, step D2) turns the
     panel into a modal dialog, shows as many bar candidates as it measures to fit, and adds the
     buttons that open sublinks. The burger turns into a cross in CSS.
     Rejected: a no-JS bar of every link that wraps (Wings and Dreamkit hid or clipped them on
     small screens instead) and a CSS breakpoint for the bar, which a long label overruns. -->
<script lang="ts">
  import { fill, ui } from '../../i18n/index.js';
  import { MAX_SEARCH_QUERY } from '@mycel/core';
  import SiteLanguages from './SiteLanguages.svelte';
  import NavTree from './NavTree.svelte';
  import { isCurrent, type ChromeLink, type ChromeModel } from './chrome.js';

  let {
    chrome,
    locale,
    current = null,
    languages = chrome.languages,
  }: {
    chrome: ChromeModel;
    locale: string;
    current?: string | null;
    languages?: ChromeModel['languages'];
  } = $props();
  const t = $derived(ui(locale));
  // Search lives in the panel even on a site without any placed menus.
  const sublinks = (label: string) => fill(t('public.menu.sublinks'), { label });
</script>

{#snippet anchor(link: ChromeLink)}
  <a href={link.href} aria-current={isCurrent(link.href, current) ? 'page' : undefined}
    >{link.label}</a
  >
{/snippet}

{#snippet action(index: number)}
  <a class="button site-action" class:secondary={index > 0} href={chrome.actions[index]!.href}
    >{chrome.actions[index]!.label}</a
  >
{/snippet}

<header class="site-header" data-site-nav data-menu-close={t('public.menu.close')}>
  <a class="site-identity" href={chrome.home} aria-label={chrome.name}>
    {#if chrome.logo}<img
        src={chrome.logo.src}
        width={chrome.logo.width}
        height={chrome.logo.height}
        alt=""
      />{/if}
    <span class:site-wordmark={chrome.wordmark}>{chrome.name}</span>
  </a>
  {#if chrome.bar.length}
    <!-- Displayed only once the enhancement has measured what fits; each item is a top-level
         node, a link or group with sublinks behind a button. -->
    <nav class="site-bar" aria-label={t('public.navigation')}>
      <ul>
        {#each chrome.bar as node, i (i)}
          <li class:site-bar-item={node.children.length > 0}>
            {#if node.kind === 'link'}
              {@render anchor(node)}
              {#if node.children.length}<button
                  type="button"
                  class="site-sub-toggle"
                  data-site-toggle
                  hidden
                  aria-expanded="false"
                  aria-controls="site-bar-{i}"
                  ><span class="site-hidden-word">{sublinks(node.label)}</span></button
                >{/if}
            {:else}
              <button
                type="button"
                class="site-bar-group"
                data-site-toggle
                hidden
                aria-expanded="false"
                aria-controls="site-bar-{i}">{node.label}</button
              >
            {/if}
            {#if node.children.length}
              <ul id="site-bar-{i}" class="site-dropdown">
                {#each node.children as child, j (j)}<li>{@render anchor(child)}</li>{/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    </nav>
  {/if}
  <div class="site-tools">
    {#if chrome.actions.length}{@render action(0)}{/if}
    {#if chrome.actions.length > 1}<a
        class="button secondary site-action"
        data-site-candidate
        href={chrome.actions[1]!.href}>{chrome.actions[1]!.label}</a
      >{/if}
    <a class="site-search-link" href={chrome.search}>{t('public.search.title')}</a>
    <SiteLanguages {languages} {locale} compact />
    <details class="site-menu">
      <summary class="site-menu-toggle">
        <span class="site-burger" aria-hidden="true"><span></span><span></span><span></span></span
        >{t('public.menu')}
      </summary>
      <div class="site-panel">
        <search aria-label={t('public.search.label')}>
          <form class="search-form" method="get" action={chrome.search}>
            <label for="site-search-q">{t('public.search.label')}</label>
            <div class="search-row">
              <input
                id="site-search-q"
                name="q"
                type="search"
                maxlength={MAX_SEARCH_QUERY}
                autocomplete="off"
                enterkeyhint="search"
              />
              <button class="button" type="submit">{t('public.search.submit')}</button>
            </div>
          </form>
        </search>
        <SiteLanguages {languages} {locale} />
        {#if chrome.main.length}
          <nav aria-label={t('public.navigation')}>
            <NavTree nodes={chrome.main} {current} toggleLabel={sublinks} idPrefix="site-panel" />
          </nav>
        {/if}
        {#if chrome.actions.length}
          <ul class="site-panel-actions">
            {#each chrome.actions as _, i (i)}<li>{@render action(i)}</li>{/each}
          </ul>
        {/if}
      </div>
    </details>
  </div>
  <script type="module" src="/_site/navigation.js"></script>
</header>
