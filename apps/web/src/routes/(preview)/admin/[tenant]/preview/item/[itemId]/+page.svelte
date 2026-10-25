<!-- The preview of one revision (TODO #11 A1): a banner that says what this is and what is not
     ready yet, in the admin's language, then the page exactly as the site renders it. Forms are
     shown but do not post. -->
<script lang="ts">
  import Blocks from '#lib/blocks/Blocks.svelte';
  import { fill, ui } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.admin));
</script>

<svelte:head>
  {#each data.theme.preload as font (font)}
    <link rel="preload" href={font} as="font" type="font/woff2" crossorigin="anonymous" />
  {/each}
  <link rel="stylesheet" href={data.theme.href} />
  <title>{t('admin.content.preview.title')}: {data.model.title}</title>
</svelte:head>

<aside class="preview-banner" lang={data.admin} aria-labelledby="preview-banner">
  <h2 id="preview-banner">{t('admin.content.preview.title')}</h2>
  <p>
    {fill(
      t(data.revision.latest ? 'admin.content.preview.latest' : 'admin.content.preview.older'),
      { when: data.revision.when, who: data.revision.who, locale: data.locale }
    )}
  </p>
  {#if data.issues.length}
    <p>{t('admin.content.preview.issues')}</p>
    <ul>
      {#each data.issues as path (path)}<li><code>{path}</code></li>{/each}
    </ul>
  {/if}
  <p><a href={data.edit}>{t('admin.content.preview.edit')}</a></p>
</aside>
<header class="site-header">
  <span class="site-identity">
    {#if data.brand.logo}<img
        src={data.brand.logo}
        width={data.brand.width ?? 1}
        height={data.brand.height ?? 1}
        alt=""
      />{/if}
    <span class:site-wordmark={data.brand.wordmark}>{data.brand.name}</span>
  </span>
</header>

<main class="page">
  <h1>{data.model.title}</h1>
  <Blocks model={data.model} preview={data.formNote} />
</main>
