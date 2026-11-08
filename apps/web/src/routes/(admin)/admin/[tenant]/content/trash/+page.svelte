<!-- The trash of pages and articles: what can come back, and one button per row, since each
     restore is its own decision about an address. The form is native. -->
<script lang="ts">
  import { Button, Notice, OverviewPage, Table } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { fill, refusalCopy, ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const failed = $derived(form && 'error' in form ? form : null);
  const restored = $derived(form && 'restored' in form ? form.restored : null);
  const number = (n: number) => new Intl.NumberFormat(data.locale).format(n);
  const now = new Date();
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
  const titleOf = (item: (typeof data.items)[number]) =>
    item.title[item.defaultLocale] ?? item.slug;
</script>

<svelte:head><title>{t('admin.content.trash.title')} · {data.tenant.name}</title></svelte:head>

<OverviewPage
  title={t('admin.content.trash.title')}
  locale={data.locale}
  breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.content.trash.title') }]}
  description={t('admin.content.trash.intro')}
  listTitle={t('admin.content.trash.title')}
  empty={data.items.length === 0
    ? { title: t('admin.content.trash.none'), body: t('admin.content.trash.intro') }
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
    {#if restored}
      <Notice tone="success">
        <p>
          <a href="{data.overview}/{restored.id}"
            >{fill(t('admin.content.trash.done'), { title: restored.title })}</a
          >
          {#if restored.slugChanged}{fill(t('admin.content.trash.moved'), {
              slug: restored.slug,
            })}{/if}
        </p>
      </Notice>
    {/if}
  {/snippet}

  <form id="content-trash" method="post" action="?/restore"></form>
  <Table
    id="content-trash-table"
    stack
    caption={t('admin.content.trash.title')}
    hideCaption
    columns={[
      { key: 'title', label: t('admin.content.trash.name') },
      { key: 'type', label: t('admin.content.type.legend') },
      { key: 'deleted', label: t('admin.content.trash.deleted') },
      { key: 'actions', label: t('admin.content.list.column.actions') },
    ]}
  >
    {#snippet rows()}
      {#each data.items as item (item.id)}
        {@const deleted = when(item.deletedAt)}
        <tr id="trash-{item.id}">
          <th scope="row">{titleOf(item)}<br /><code>{item.slug}</code></th>
          <td data-label={t('admin.content.type.legend')}
            >{t(`admin.content.type.${item.type}` as const)}</td
          >
          <td data-label={t('admin.content.trash.deleted')}
            ><time datetime={deleted.iso} title={deleted.full}>{deleted.text}</time></td
          >
          <td data-label={t('admin.content.list.column.actions')}>
            <Button
              variant="secondary"
              form="content-trash"
              name="item"
              value={item.id}
              aria-label="{t('admin.content.trash.restore')}: {titleOf(item)}"
              >{t('admin.content.trash.restore')}</Button
            >
          </td>
        </tr>
      {/each}
    {/snippet}
  </Table>
</OverviewPage>
