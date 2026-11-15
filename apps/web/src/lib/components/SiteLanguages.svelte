<!-- Native language disclosure in the bar, plain links in the panel. Published alternatives
     are supplied by the page; no guessed translated slug or JavaScript navigation. Rejected: a script-only picker,
     which loses language switching with JavaScript off. -->
<script lang="ts">
  import { ui } from '../../i18n/index.js';
  import type { ChromeLanguage } from './chrome.js';
  let {
    languages,
    locale,
    compact = false,
  }: {
    languages: ChromeLanguage[];
    locale: string;
    compact?: boolean;
  } = $props();
  const t = $derived(ui(locale));
</script>

{#snippet links()}
  <nav class="site-language-links" aria-label={t('public.languages')}>
    {#each languages as language (language.locale)}
      <a
        href={language.href}
        hreflang={language.locale}
        lang={language.locale}
        aria-current={language.locale === locale ? 'true' : undefined}>{language.label}</a
      >
    {/each}
  </nav>
{/snippet}

{#if languages.length > 1}
  {#if compact}
    <details class="site-languages">
      <summary>{t('public.languages')}</summary>
      {@render links()}
    </details>
  {:else}
    {@render links()}
  {/if}
{/if}
