<!-- Only a POST from the editor supplies a draft. The native saved-preview link remains the
     keyboard and no-JavaScript route. Block wrappers carry ids solely for click-to-edit. -->
<script lang="ts">
  import Blocks from '#lib/blocks/Blocks.svelte';
  import Intro from '#lib/blocks/Intro.svelte';
  import { ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(form?.admin ?? data.admin));
</script>

<svelte:head>
  {#if form?.model}
    {#each form.theme.preload as font (font)}
      <link rel="preload" href={font} as="font" type="font/woff2" crossorigin="anonymous" />
    {/each}
    <link rel="stylesheet" href={form.theme.href} />
    <title>{t('admin.content.preview.live')}: {form.model.title}</title>
  {/if}
</svelte:head>

{#if form?.model}
  <aside class="preview-banner" lang={form.admin} aria-labelledby="preview-banner">
    <h2 id="preview-banner">{t('admin.content.preview.live')}</h2>
    {#if form.issues.length}
      <p>{t('admin.content.preview.issues')}</p>
      <ul>
        {#each form.issues as path (path)}<li><code>{path}</code></li>{/each}
      </ul>
    {/if}
  </aside>
  <header class="site-header">
    <span class="site-identity">
      {#if form.brand.logo}<img
          src={form.brand.logo}
          width={form.brand.width ?? 1}
          height={form.brand.height ?? 1}
          alt=""
        />{/if}
      <span class:site-wordmark={form.brand.wordmark}>{form.brand.name}</span>
    </span>
  </header>
  <!-- `data-live-preview-rendered`: the editor shows this frame only once it carries the mark, so
       a refused draft (an error page) never replaces the last good image (#66 PR 6d). -->
  <main class="page" data-drop-cap={form.dropCap ? '' : undefined} data-live-preview-rendered>
    <h1>{form.model.title}</h1>
    <Intro intro={form.intro} model={form.model} />
    <Blocks
      model={form.model}
      preview={form.formNote}
      selectable
      eagerFirstImage={!form.intro.hero}
    />
  </main>
  <script type="module" src="/_admin/live-preview-child.js"></script>
{:else}
  <main class="page"><h1>{t('admin.content.preview.live')}</h1></main>
{/if}
