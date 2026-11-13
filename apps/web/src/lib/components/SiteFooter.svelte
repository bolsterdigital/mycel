<!-- The site footer (docs/architecture/content-layout.md § Site chrome), from the same
     `chromeModel` as the header; the credit is decided there (ADR 015 rule 5). -->
<script lang="ts">
  import { ui } from '../../i18n/index.js';
  import MycelCredit from './MycelCredit.svelte';
  import type { ChromeLink, ChromeModel } from './chrome.js';

  let {
    chrome,
    credit,
    locale,
  }: { chrome: ChromeModel; credit: ChromeLink | null; locale: string } = $props();
  const t = $derived(ui(locale));
</script>

<footer class="site-footer">
  {#if chrome.footer}<p>{chrome.footer}</p>{/if}
  {#if chrome.legal.length || chrome.support || chrome.help}
    <nav aria-label={t('public.footerNavigation')}>
      {#each chrome.legal as item (item.href)}<a href={item.href}>{item.label}</a>{/each}
      {#if chrome.support}<a href={chrome.support.href}>{chrome.support.label}</a>{/if}
      {#if chrome.help}<a href={chrome.help.href}>{chrome.help.label}</a>{/if}
    </nav>
  {/if}
  {#if credit}<MycelCredit {...credit} />{/if}
</footer>
