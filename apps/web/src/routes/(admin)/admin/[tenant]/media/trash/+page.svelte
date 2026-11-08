<!-- The trash of the media library: what is restorable, until when, and a selection to
     bring back. A table, like every list of equal things; the bulk form is native. -->
<script lang="ts">
  import BulkResults from '#lib/admin/media/BulkResults.svelte';
  import { Actions, Button, Notice, OverviewPage, Table } from '#lib/admin/ui/index.js';
  import { formatBytes, formatWhen } from '#lib/admin/format.js';
  import { fill, refusalCopy, ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form?.results ? { action: form.action, results: form.results } : null);
  const number = (n: number) => new Intl.NumberFormat(data.locale).format(n);
  const now = new Date();
  const when = (iso: string, relative: boolean) =>
    formatWhen(iso, { locale: data.locale, zone: data.timeZone, now, relative });
</script>

<svelte:head><title>{t('admin.media.trash.title')} · {data.tenant.name}</title></svelte:head>

<OverviewPage
  title={t('admin.media.trash.title')}
  locale={data.locale}
  breadcrumb={[
    { label: data.tenant.name, href: base },
    { label: t('admin.media.title'), href: data.library },
    { label: t('admin.media.trash.title') },
  ]}
  description={t('admin.media.trash.intro')}
  listTitle={t('admin.media.trash.title')}
  empty={data.items.length === 0
    ? { title: t('admin.media.trash.none'), body: t('admin.media.trash.intro') }
    : undefined}
  paging={data.previous || data.next
    ? {
        previous: data.previous,
        next: data.next,
        position: fill(t('admin.content.list.position'), {
          from: number(data.range.from),
          to: number(data.range.to),
          total: number(data.total),
        }),
      }
    : undefined}
>
  {#snippet notices()}
    {#if failed}
      <Notice tone="error" title={t('error.summary.title')}><p>{refusalCopy(t, failed)}</p></Notice>
    {/if}
    {#if done}
      <Notice tone="success">
        <BulkResults id="media-trash-results" results={done.results} locale={data.locale} />
      </Notice>
    {/if}
  {/snippet}

  {#snippet filters()}
    <form id="media-trash" method="post" action="?/restore" class="ui-list-display-form">
      <Actions><Button variant="secondary">{t('admin.media.trash.restore')}</Button></Actions>
    </form>
  {/snippet}

  <Table
    id="media-trash-table"
    stack
    caption={t('admin.media.trash.title')}
    columns={[
      { key: 'name', label: t('admin.media.filename') },
      { key: 'size', label: t('admin.media.size'), numeric: true },
      { key: 'deleted', label: t('admin.media.trash.deleted') },
      { key: 'until', label: t('admin.media.trash.until') },
    ]}
  >
    {#snippet rows()}
      {#each data.items as file (file.id)}
        {@const deleted = when(file.deletedAt, data.dateFormat !== 'absolute')}
        {@const until = when(file.restorableUntil, false)}
        <tr id="trash-{file.id}">
          <th scope="row">
            {file.filename}
            <div class="ui-choice">
              <input
                type="hidden"
                form="media-trash"
                name="name"
                value="{file.id} {file.filename}"
              />
              <input
                id="trash-select-{file.id}"
                type="checkbox"
                form="media-trash"
                name="selected"
                value={file.id}
              />
              <label for="trash-select-{file.id}"
                >{fill(t('admin.media.bulk.selectOne'), { filename: file.filename })}</label
              >
            </div>
          </th>
          <td class="numeric" data-label={t('admin.media.size')}
            >{formatBytes(file.sizeBytes, data.locale)}</td
          >
          <td data-label={t('admin.media.trash.deleted')}
            ><time datetime={deleted.iso} title={deleted.full}>{deleted.text}</time></td
          >
          <td data-label={t('admin.media.trash.until')}
            ><time datetime={until.iso} title={until.full}>{until.text}</time></td
          >
        </tr>
      {/each}
    {/snippet}
  </Table>
</OverviewPage>
