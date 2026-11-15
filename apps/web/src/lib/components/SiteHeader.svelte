<!-- The site header (docs/architecture/content-layout.md § Site chrome). The public layout and both
     item previews render it from one `chromeModel`, so a preview shows the site's own header,
     navigation included.

     This is the baseline without JavaScript (ADR 036 rule 12): the logo, the
     first call to action and Menu, a native `details` whose panel holds the whole main menu and
     both calls to action. Which top-level links also stand in the bar is measured, so it comes
     with the enhancement (step D2); until then they are one click away in the panel, never
     clipped or wrapped into a second row of links. The burger turns into a cross in CSS.
     Rejected: a no-JS bar of every link that wraps (Wings and Dreamkit hid or clipped them on
     small screens instead) and a CSS breakpoint for the bar, which a long label overruns. -->
<script lang="ts">
  import { ui } from '../../i18n/index.js';
  import NavTree from './NavTree.svelte';
  import type { ChromeModel } from './chrome.js';

  let {
    chrome,
    locale,
    current = null,
  }: { chrome: ChromeModel; locale: string; current?: string | null } = $props();
  const t = $derived(ui(locale));
  // One call to action alone is in the bar already; the panel would only repeat it.
  const panel = $derived(chrome.main.length > 0 || chrome.actions.length > 1);
</script>

{#snippet action(index: number)}
  <a class="button site-action" class:secondary={index > 0} href={chrome.actions[index]!.href}
    >{chrome.actions[index]!.label}</a
  >
{/snippet}

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
  {#if chrome.actions.length || panel}
    <div class="site-tools">
      {#if chrome.actions.length}{@render action(0)}{/if}
      {#if panel}
        <details class="site-menu">
          <summary class="site-menu-toggle">
            <span class="site-burger" aria-hidden="true"
              ><span></span><span></span><span></span></span
            >{t('public.menu')}
          </summary>
          <div class="site-panel">
            {#if chrome.main.length}
              <nav aria-label={t('public.navigation')}>
                <NavTree nodes={chrome.main} {current} />
              </nav>
            {/if}
            {#if chrome.actions.length}
              <ul class="site-panel-actions">
                {#each chrome.actions as _, i (i)}<li>{@render action(i)}</li>{/each}
              </ul>
            {/if}
          </div>
        </details>
      {/if}
    </div>
  {/if}
</header>
