<!-- The media library of a site (TODO #10b, brief #56 § C1) on the overview pattern: upload at
     the top, the library as a grid of thumbnails or as a table, each asset a link to its own
     page with preview, details, edit and delete. Every action is a native form post or a link,
     so nothing needs JavaScript; e2e/media.spec.ts checks 320 CSS px and 200% text. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Card,
    CardGrid,
    Choices,
    FileDrop,
    Fieldset,
    Notice,
    OverviewPage,
    Table,
  } from '#lib/admin/ui/index.js';
  import { formatBytes } from '#lib/admin/format.js';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const size = (n: number) => formatBytes(n, data.locale);

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const filenameOf = (f: Record<string, unknown>) =>
    typeof f.filename === 'string' ? f.filename : '';
  const failure = $derived(
    failed
      ? fill(t(failed.error as UiKey), {
          what: 'what' in failed && failed.what ? t(failed.what as UiKey) : '',
          filename: filenameOf(failed),
          max: size(data.maxUploadBytes),
        })
      : ''
  );
  const viewHref = (view: 'grid' | 'list') => (view === 'grid' ? '?' : '?view=list');
  const usage = (n: number) =>
    fill(t(n === 1 ? 'admin.media.usage.one' : 'admin.media.usage.other'), { n });
  const access = (a: string) =>
    t(a === 'restricted' ? 'admin.media.access.restricted' : 'admin.media.access.public');
  const dimensions = (m: { width: number | null; height: number | null }) =>
    m.width && m.height ? `${m.width} × ${m.height} px` : '';
</script>

<svelte:head>
  <title>{failed ? `${t('error.prefix')} ` : ''}{t('admin.media.title')} · {data.tenant.name}</title
  >
</svelte:head>

<OverviewPage
  title={t('admin.media.title')}
  locale={data.locale}
  breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.media.title') }]}
  description={data.storage
    ? fill(t('admin.media.storage'), {
        used: size(data.storage.usedBytes),
        max: size(data.storage.maxBytes),
      })
    : undefined}
  listTitle={t('admin.media.library')}
  views={{
    label: t('admin.media.view.label'),
    items: [
      { href: viewHref('grid'), label: t('admin.media.view.grid'), current: data.view === 'grid' },
      { href: viewHref('list'), label: t('admin.media.view.list'), current: data.view === 'list' },
    ],
  }}
  empty={data.items.length === 0
    ? { title: t('admin.media.none'), body: t('admin.media.none.body') }
    : undefined}
  paging={data.nextCursor
    ? {
        next: `?cursor=${data.nextCursor}${data.view === 'list' ? '&view=list' : ''}`,
      }
    : undefined}
>
  {#snippet notices()}
    {#if failed}
      <Notice tone="error" title={t('error.summary.title')}><p>{failure}</p></Notice>
    {/if}
    {#if done}
      <Notice tone="success">
        <p>{fill(t(done.done as UiKey), { filename: filenameOf(done) })}</p>
        {#if 'id' in done && done.id}
          <p>
            <a href="{base}/media/{done.id}"
              >{fill(t('admin.media.done.open'), { filename: filenameOf(done) })}</a
            >
          </p>
        {/if}
      </Notice>
    {:else if data.deleted}
      <Notice tone="success"><p>{t('admin.media.done.deletedFile')}</p></Notice>
    {/if}
  {/snippet}

  {#snippet intro()}
    <form method="post" action="?/upload" enctype="multipart/form-data">
      <Fieldset legend={t('admin.media.upload.title')}>
        <FileDrop
          id="upload-file"
          name="file"
          label={t('admin.media.upload.file')}
          locale={data.locale}
          accept="image/jpeg,image/png,image/webp,image/avif,image/gif,application/pdf"
          hint={fill(t('admin.media.upload.hint'), { max: size(data.maxUploadBytes) })}
          required
        />
        <Choices
          id="upload"
          name="access"
          type="checkbox"
          legend={t('admin.media.access')}
          locale={data.locale}
          options={[{ value: 'restricted', label: t('admin.media.upload.restricted') }]}
        />
        <Actions><Button>{t('admin.media.upload.submit')}</Button></Actions>
      </Fieldset>
    </form>
  {/snippet}

  {#if data.view === 'list'}
    <Table
      id="media-table"
      caption={t('admin.media.library')}
      columns={[
        { key: 'thumb', label: t('admin.media.preview') },
        { key: 'name', label: t('admin.media.filename') },
        { key: 'dimensions', label: t('admin.media.dimensions') },
        { key: 'size', label: t('admin.media.size'), numeric: true },
        { key: 'usage', label: t('admin.media.usage') },
        { key: 'access', label: t('admin.media.access') },
      ]}
    >
      {#snippet rows()}
        {#each data.items as m (m.id)}
          <tr>
            <td>
              {#if m.thumb}
                <img
                  class="ui-thumb"
                  src="{base}/media/{m.id}/thumb"
                  alt=""
                  width="48"
                  height="48"
                  loading="lazy"
                />
              {/if}
            </td>
            <th scope="row"><a href="{base}/media/{m.id}">{m.filename}</a></th>
            <td>{dimensions(m)}</td>
            <td class="numeric">{size(m.sizeBytes)}</td>
            <td>{usage(m.usageCount)}</td>
            <td>{access(m.access)}</td>
          </tr>
        {/each}
      {/snippet}
    </Table>
  {:else}
    <CardGrid items={data.items} key={(m) => m.id} label={t('admin.media.library')}>
      {#snippet card(m)}
        <Card title={m.filename} href="{base}/media/{m.id}">
          {#snippet media()}
            {#if m.thumb}
              <img src="{base}/media/{m.id}/thumb" alt="" width="320" height="240" loading="lazy" />
            {/if}
          {/snippet}
          <p class="muted">{[dimensions(m), size(m.sizeBytes)].filter(Boolean).join(' · ')}</p>
          <p class="muted">{usage(m.usageCount)}</p>
          {#snippet footer()}
            <Badge tone={m.access === 'restricted' ? 'warning' : 'neutral'}
              >{access(m.access)}</Badge
            >
          {/snippet}
        </Card>
      {/snippet}
    </CardGrid>
  {/if}
</OverviewPage>
