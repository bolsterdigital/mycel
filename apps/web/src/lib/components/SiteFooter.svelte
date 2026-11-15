<!-- The site footer (docs/architecture/content-layout.md § Site chrome), from the same
     `chromeModel` as the header; the credit is decided there (ADR 015 rule 5). Each placed column
     is its own list under its title, every group open, then the legal menu. -->
<script lang="ts">
  import { ui } from '../../i18n/index.js';
  import MycelCredit from './MycelCredit.svelte';
  import NavTree from './NavTree.svelte';
  import type { ChromeLink, ChromeModel } from './chrome.js';

  let {
    chrome,
    credit,
    locale,
    current = null,
  }: {
    chrome: ChromeModel;
    credit: ChromeLink | null;
    locale: string;
    current?: string | null;
  } = $props();
  const t = $derived(ui(locale));
</script>

<footer class="site-footer">
  {#if chrome.footer}<p>{chrome.footer}</p>{/if}
  {#if chrome.columns.length || chrome.legal.length}
    <nav aria-label={t('public.footerNavigation')}>
      {#if chrome.columns.length}
        <div class="site-footer-columns">
          {#each chrome.columns as column, c (c)}
            <div class="site-footer-column">
              {#if column.title}<h2 class="site-footer-title">{column.title}</h2>{/if}
              <NavTree nodes={column.nodes} {current} openGroups />
            </div>
          {/each}
        </div>
      {/if}
      {#if chrome.legal.length}
        <div class="site-footer-legal"><NavTree nodes={chrome.legal} {current} openGroups /></div>
      {/if}
    </nav>
  {/if}
  {#if credit}<MycelCredit {...credit} />{/if}
</footer>
