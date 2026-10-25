<script lang="ts">
  import '#lib/theme/base.css';
  import MycelCredit from '#lib/components/MycelCredit.svelte';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
</script>

<svelte:head>
  {#if data.theme}
    {#each data.theme.preload as font (font)}
      <link rel="preload" href={font} as="font" type="font/woff2" crossorigin="anonymous" />
    {/each}
    <link rel="stylesheet" href={data.theme.href} />
  {/if}
</svelte:head>

{#if data.chrome}
  <a class="public-skip" href="#public-main"
    >{data.locale === 'nl' ? 'Ga naar inhoud' : 'Skip to content'}</a
  >
  <header class="site-header">
    <nav aria-label={data.locale === 'nl' ? 'Hoofdnavigatie' : 'Main navigation'}>
      {#each data.chrome.navigation as item (item.href)}<a href={item.href}>{item.label}</a>{/each}
    </nav>
  </header>
{/if}
<div id="public-main">{@render children()}</div>
{#if data.chrome}
  <footer class="site-footer">
    {#if data.chrome.footer}<p>{data.chrome.footer}</p>{/if}
    <nav aria-label={data.locale === 'nl' ? 'Voettekst' : 'Footer'}>
      {#each data.chrome.legal as item (item.href)}<a href={item.href}>{item.label}</a>{/each}
      {#if data.chrome.support}<a href={data.chrome.support.href}>{data.chrome.support.label}</a
        >{/if}
      {#if data.chrome.help}<a href={data.chrome.help.href}>{data.chrome.help.label}</a>{/if}
    </nav>
    {#if data.credit}<MycelCredit {...data.credit} />{/if}
  </footer>
{/if}
