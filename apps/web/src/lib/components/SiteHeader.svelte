<!-- The site header (docs/architecture/content-layout.md § Site chrome). The public layout and both
     item previews render it from one `chromeModel`, so a preview shows the site's own header,
     navigation included. -->
<script lang="ts">
  import { ui } from '../../i18n/index.js';
  import type { ChromeModel } from './chrome.js';

  let { chrome, locale }: { chrome: ChromeModel; locale: string } = $props();
  const t = $derived(ui(locale));
</script>

<header class="site-header">
  <a class="site-identity" href={chrome.home} aria-label={chrome.name}>
    {#if chrome.logo}<img
        src={chrome.logo.src}
        width={chrome.logo.width}
        height={chrome.logo.height}
        alt=""
      />{/if}
    <span class:site-wordmark={chrome.wordmark}>{chrome.name}</span>
  </a>
  {#if chrome.navigation.length}
    <nav aria-label={t('public.navigation')}>
      {#each chrome.navigation as item (item.href)}<a href={item.href}>{item.label}</a>{/each}
    </nav>
  {/if}
</header>
