<!-- The export page of a site (TODO #28) on the shared admin components (brief #56): what an
     archive holds and how long it stays, one button to ask for one (a native form post), and the
     earlier archives as cards with a status badge, the facts as a MetaList and the download under
     them. e2e/export.spec.ts checks 320 CSS px and 200% text (skill
     ui-action-layout). -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Card,
    CardGrid,
    MetaList,
    Notice,
    PageHeader,
  } from '#lib/admin/ui/index.js';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const when = $derived(
    new Intl.DateTimeFormat(data.locale, { dateStyle: 'medium', timeStyle: 'short' })
  );
  const at = (iso: string) => when.format(new Date(iso));
  const size = $derived(new Intl.NumberFormat(data.locale, { maximumFractionDigits: 1 }));
  const bytes = (n: number) =>
    n >= 1024 ** 3
      ? `${size.format(n / 1024 ** 3)} GB`
      : n >= 1024 ** 2
        ? `${size.format(n / 1024 ** 2)} MB`
        : `${size.format(Math.max(n / 1024, 0.1))} kB`;
  type Item = (typeof data.exports)[number];
  const TONE: Record<string, 'neutral' | 'info' | 'success' | 'error'> = {
    queued: 'neutral',
    running: 'info',
    ready: 'success',
    failed: 'error',
    expired: 'neutral',
  };
  const facts = (item: Item) => [
    { term: t('admin.export.field.by'), value: item.requestedBy },
    ...(item.sizeBytes !== null
      ? [{ term: t('admin.export.field.size'), value: bytes(item.sizeBytes) }]
      : []),
    ...(item.status === 'ready' && item.expiresAt
      ? [{ term: t('admin.export.field.expires'), value: at(item.expiresAt) }]
      : []),
    ...(item.sha256 ? [{ term: t('admin.export.field.sha256'), value: item.sha256 }] : []),
    ...(item.error ? [{ term: t('admin.export.field.error'), value: item.error }] : []),
  ];
  const STATUS: Record<string, UiKey> = {
    queued: 'admin.export.status.queued',
    running: 'admin.export.status.running',
    ready: 'admin.export.status.ready',
    failed: 'admin.export.status.failed',
    expired: 'admin.export.status.expired',
  };
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.export.title')} · {data.tenant.name}</title
  >
</svelte:head>

<main class="page admin">
  <PageHeader
    title={t('admin.export.title')}
    locale={data.locale}
    breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.export.title') }]}
  />

  {#if failed}
    <Notice tone="error" title={t('error.summary.title')}><p>{t(failed.error as UiKey)}</p></Notice>
  {/if}
  {#if done}
    <Notice tone="success"><p>{t(done.done as UiKey)}</p></Notice>
  {/if}

  <section aria-labelledby="request">
    <h2 id="request">{t('admin.export.request.title')}</h2>
    <p>{t('admin.export.intro.contents')}</p>
    <p>{fill(t('admin.export.intro.lifetime'), { days: data.retentionDays })}</p>
    <form method="post" action="?/request">
      <Actions><Button>{t('admin.export.request.button')}</Button></Actions>
    </form>
  </section>

  <section aria-labelledby="archives">
    <h2 id="archives">{t('admin.export.list.title')}</h2>
    {#if data.exports.length === 0}
      <p>{t('admin.export.list.none')}</p>
    {:else}
      <p class="ui-hint">{t('admin.export.list.reload')}</p>
      <CardGrid items={data.exports} key={(item) => item.id}>
        {#snippet card(item)}
          <Card title={fill(t('admin.export.item'), { time: at(item.requestedAt) })}>
            <p>
              <Badge tone={TONE[item.status] ?? 'neutral'}
                >{t(STATUS[item.status] ?? 'admin.export.status.queued')}</Badge
              >
            </p>
            <MetaList items={facts(item)} />
            {#if item.href}
              <Actions>
                <Button variant="secondary" href={item.href} download
                  >{t('admin.export.download')}</Button
                >
              </Actions>
            {:else if item.status === 'expired'}
              <p>{t('admin.export.expired')}</p>
            {/if}
          </Card>
        {/snippet}
      </CardGrid>
    {/if}
  </section>
</main>
