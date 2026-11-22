<!-- Native language disclosure in the bar, a row of pills in the panel. Published alternatives
     are supplied by the page; no guessed translated slug or JavaScript navigation. The bar's
     summary is a globe plus the visible word, so whoever cannot read the page's language still
     finds it (MY-266); the choices are pills with the current one filled. Rejected: a script-only
     picker, which loses language switching with JavaScript off, and flags, which name countries,
     not languages. -->
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

{#snippet globe()}
  <svg
    class="site-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    aria-hidden="true"
    ><circle cx="12" cy="12" r="9" /><path
      d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z"
    /></svg
  >
{/snippet}

{#snippet links()}
  <nav class="site-language-links" aria-label={t('public.languages')}>
    {#if !compact}{@render globe()}{/if}
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
      <summary>{@render globe()}{t('public.languages')}</summary>
      {@render links()}
    </details>
  {:else}
    {@render links()}
  {/if}
{/if}
