<!-- Manage (#114): the screens about who and what runs the site, each with one sentence on what
     you do there, so the page works without the menu. The list comes from the same data file as
     the menu (src/lib/admin/nav.ts) and shows only what the member may open. -->
<script lang="ts">
  import { page } from '$app/state';
  import { Card, CardGrid, PageHeader } from '#lib/admin/ui/index.js';
  import { navEntries } from '#lib/admin/nav.js';
  import { ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const screens = $derived(
    navEntries({
      base,
      pathname: page.url.pathname,
      search: '',
      capabilities: data.capabilities,
      t,
    }).find((e) => e.id === 'manage')?.children ?? []
  );
</script>

<svelte:head>
  <title>{t('admin.manage.title')} · {data.tenant.name}</title>
</svelte:head>

<main class="page admin">
  <PageHeader
    title={t('admin.manage.title')}
    locale={data.locale}
    breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.manage.title') }]}
    description={t('admin.manage.lead')}
  />
  <CardGrid items={screens} key={(s) => s.href}>
    {#snippet card(screen)}
      <Card title={screen.label} href={screen.href} level={2}><p>{screen.hint}</p></Card>
    {/snippet}
  </CardGrid>
</main>
