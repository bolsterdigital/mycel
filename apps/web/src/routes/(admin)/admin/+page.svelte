<!-- The site picker (brief #56 § C3): the sites the operator is a member of as cards, each card's
     heading the one link to that site's admin, or an empty state that says whom to ask. -->
<script lang="ts">
  import Header from '#lib/admin/Header.svelte';
  import { Card, CardGrid, EmptyState, PageHeader } from '#lib/admin/ui/index.js';
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
  <PageHeader title={t('admin.sites.title')} locale={data.locale} />
  {#if data.sites.length}
    <CardGrid items={data.sites} key={(site) => site.slug} label={t('admin.sites.title')}>
      {#snippet card(site)}
        <Card title={site.name} href="/admin/{site.slug}" level={2} />
      {/snippet}
    </CardGrid>
  {:else}
    <EmptyState title={t('admin.sites.empty')}>
      <p>{fill(t('admin.sites.none'), { email: data.email })}</p>
    </EmptyState>
  {/if}
</main>
