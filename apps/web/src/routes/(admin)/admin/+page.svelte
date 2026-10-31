<!-- The site picker (brief #56 § C3, admin-entry § 4-5): the sites the operator is a member of as
     cards, each card's heading the one link to that site's admin and its body the operator's role
     there; a GET search field from nine sites on, so it works without JavaScript. With no site an
     empty state says what happened to invitations and whom to ask. One site never shows this page
     unless asked for (`?all`, +page.server.ts). -->
<script lang="ts">
  import Header from '#lib/admin/Header.svelte';
  import {
    Actions,
    Button,
    Card,
    CardGrid,
    EmptyState,
    Field,
    PageHeader,
  } from '#lib/admin/ui/index.js';
  import { fill, ui, type UiKey } from '../../../i18n/index.js';
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
  {#if data.searchable}
    <form method="get" class="ui-fields" role="search" aria-label={t('admin.sites.search')}>
      <input type="hidden" name="all" value="" />
      <Field
        id="sites-q"
        name="q"
        type="search"
        size="m"
        value={data.q}
        label={t('admin.sites.search')}
        locale={data.locale}
      />
      <Actions>
        <Button variant="secondary">{t('admin.sites.search.submit')}</Button>
        {#if data.q}
          <Button variant="link" href="/admin?all">{t('admin.sites.search.clear')}</Button>
        {/if}
      </Actions>
    </form>
  {/if}
  {#if data.sites.length}
    <CardGrid items={data.sites} key={(site) => site.slug} label={t('admin.sites.title')}>
      {#snippet card(site)}
        <Card title={site.name} href="/admin/{site.slug}" level={2}>
          <p>{t(`admin.role.${site.role}` as UiKey)}</p>
        </Card>
      {/snippet}
    </CardGrid>
  {:else if data.total}
    <p>{fill(t('admin.sites.noMatch'), { q: data.q })}</p>
  {:else}
    <EmptyState title={t('admin.sites.empty')}>
      <p>{fill(t('admin.sites.none'), { email: data.email })}</p>
      <p>{t('admin.sites.none.invited')}</p>
    </EmptyState>
  {/if}
</main>
