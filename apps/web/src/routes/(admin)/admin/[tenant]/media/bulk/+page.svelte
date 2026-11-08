<!-- The confirmation and the result of a bulk delete. Before: what is selected, what
     happens, the files in use named as staying. After: one line per file, a way to restore what
     went and to try again what was in use. No script. -->
<script lang="ts">
  import BulkResults from '#lib/admin/media/BulkResults.svelte';
  import { Actions, Button, Notice, OverviewPage, Table } from '#lib/admin/ui/index.js';
  import { fill, refusalCopy, ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form?.results ? { action: form.action, results: form.results } : null);
  const deleted = $derived(done?.results.filter((r) => r.status === 'deleted') ?? []);
  const inUse = $derived(done?.results.filter((r) => r.status === 'in-use') ?? []);
  const inUseFiles = $derived(data.files.filter((f) => f.usageCount > 0).length);
  const number = (n: number) => new Intl.NumberFormat(data.locale).format(n);
  const usage = (n: number) =>
    fill(t(n === 1 ? 'admin.media.usage.one' : 'admin.media.usage.other'), { n });
</script>

<svelte:head><title>{t('admin.media.bulk.title')} · {data.tenant.name}</title></svelte:head>

<OverviewPage
  title={t('admin.media.bulk.title')}
  locale={data.locale}
  breadcrumb={[
    { label: data.tenant.name, href: base },
    { label: t('admin.media.title'), href: data.back },
    { label: t('admin.media.bulk.title') },
  ]}
  listTitle={t('admin.media.bulk.title')}
>
  {#snippet notices()}
    {#if failed}
      <Notice tone="error" title={t('error.summary.title')}><p>{refusalCopy(t, failed)}</p></Notice>
    {/if}
  {/snippet}

  {#if done}
    <p id="media-bulk-summary">
      {fill(t(`admin.media.bulk.done.${done.action === 'restore' ? 'restored' : 'deleted'}`), {
        n: number(
          done.action === 'restore'
            ? done.results.filter((r) => r.status === 'restored').length
            : deleted.length
        ),
        total: number(done.results.length),
      })}
    </p>
    <BulkResults id="media-bulk-results" results={done.results} locale={data.locale} />
    <Actions stack>
      {#if done.action === 'delete' && deleted.length}
        <form method="post" action="?/restore">
          {#each deleted as r (r.id)}<input type="hidden" name="selected" value={r.id} />{/each}
          <Button variant="secondary">{t('admin.media.bulk.restore')}</Button>
        </form>
      {/if}
      {#if done.action === 'delete' && inUse.length}
        <form method="post" action="?/delete">
          {#each inUse as r (r.id)}<input type="hidden" name="selected" value={r.id} />{/each}
          <Button variant="secondary">{t('admin.media.bulk.retry')}</Button>
        </form>
      {/if}
      <Button variant="secondary" href={data.trash}>{t('admin.media.trash.title')}</Button>
      <Button variant="link" href={data.back}>{t('admin.media.bulk.back')}</Button>
    </Actions>
  {:else if data.files.length === 0}
    <p>{t('admin.media.bulk.none')}</p>
    <Actions><Button variant="link" href={data.back}>{t('admin.media.bulk.back')}</Button></Actions>
  {:else}
    <p id="media-bulk-summary">
      {fill(
        t(
          data.files.length === 1
            ? 'admin.media.bulk.summary.one'
            : 'admin.media.bulk.summary.other'
        ),
        {
          n: number(data.files.length),
        }
      )}
      {t('admin.media.bulk.scope')}
    </p>
    {#if inUseFiles}
      <Notice tone="warning"><p>{t('admin.media.bulk.inUseStays')}</p></Notice>
    {/if}
    <Table
      id="media-bulk-files"
      stack
      caption={t('admin.media.bulk.files')}
      columns={[
        { key: 'name', label: t('admin.media.filename') },
        { key: 'usage', label: t('admin.media.usage') },
      ]}
    >
      {#snippet rows()}
        {#each data.files as file (file.id)}
          <tr>
            <th scope="row">{file.filename}</th>
            <td data-label={t('admin.media.usage')}>{usage(file.usageCount)}</td>
          </tr>
        {/each}
      {/snippet}
    </Table>
    <form method="post" action="?/delete">
      {#each data.files as file (file.id)}<input
          type="hidden"
          name="selected"
          value={file.id}
        />{/each}
      <Actions stack>
        <Button variant="danger">{t('admin.media.bulk.confirm')}</Button>
        <Button variant="link" href={data.back}>{t('admin.ui.cancel')}</Button>
      </Actions>
    </form>
  {/if}
</OverviewPage>
