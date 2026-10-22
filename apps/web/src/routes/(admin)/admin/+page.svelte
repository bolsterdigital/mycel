<script lang="ts">
  import Header from '#lib/admin/Header.svelte';
  import { fill, ui } from '../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
</script>

<svelte:head>
  <title>{t('admin.sites.title')} · {t('admin.title')}</title>
</svelte:head>

<Header locale={data.locale} email={data.email} />
<main class="page admin">
  <h1>{t('admin.sites.title')}</h1>
  {#if data.sites.length}
    <ul>
      {#each data.sites as site (site.slug)}
        <li><a href="/admin/{site.slug}">{site.name}</a></li>
      {/each}
    </ul>
  {:else}
    <p>{fill(t('admin.sites.none'), { email: data.email })}</p>
  {/if}
</main>
