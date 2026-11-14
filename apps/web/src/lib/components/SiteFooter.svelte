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
  {#if chrome.columns.length || chrome.legal.length}
    <nav aria-label={t('public.footerNavigation')}>
      {#each chrome.columns as column, c (c)}
        {#if column.title}<h2 class="site-footer-title">{column.title}</h2>{/if}
        {#each column.links as item, i (i)}<a href={item.href}>{item.label}</a>{/each}
      {/each}
      {#each chrome.legal as item, i (i)}<a href={item.href}>{item.label}</a>{/each}
    </nav>
  {/if}
  {#if credit}<MycelCredit {...credit} />{/if}
</footer>
