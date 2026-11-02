<!-- The media library starts with its assets, not a full-page upload form (#80A). A compact
     button opens the native upload dialog; a window-wide drop enhancement reports progress and
     per-file failures, then refreshes the server-rendered library. The dialog, search, views and
     asset links remain usable without JavaScript; media.spec.ts checks both paths and reflow. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Card,
    CardGrid,
    Choices,
    Field,
    FileDrop,
    Dialog,
    UploadDropZone,
    Fieldset,
    Notice,
    OverviewPage,
    Table,
  } from '#lib/admin/ui/index.js';
  import { formatBytes } from '#lib/admin/format.js';
  import { THUMB, thumbPath } from '#lib/admin/ui/thumb.js';
  import { fill, ui, refusalCopy } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const size = (n: number) => formatBytes(n, data.locale);

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form && form.done ? form : null);
  const filenameOf = (f: Record<string, unknown>) =>
    typeof f.filename === 'string' ? f.filename : '';
  const failure = $derived(
    failed
      ? refusalCopy(t, failed, {
          filename: filenameOf(failed),
          max: size(data.maxUploadBytes),
        })
      : ''
  );
  const refused = (f: Record<string, unknown>) =>
    Array.isArray(f.refused)
      ? (f.refused as { filename: string; error: string; what?: string }[])
      : [];
  const refusal = (r: { filename: string; error: string; what?: string }) =>
    `${r.filename}: ${refusalCopy(t, r, {
      filename: r.filename,
      max: size(data.maxUploadBytes),
    })}`;
  const query = (view: 'grid' | 'list', extra: Record<string, string> = {}) => {
    const params = new URLSearchParams({
      ...(data.q ? { q: data.q } : {}),
      ...(view === 'list' ? { view } : {}),
      ...extra,
    });
    return `?${params}`;
  };
  const viewHref = (view: 'grid' | 'list') => query(view);
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
  listTitle={t('admin.media.title')}
  views={{
    label: t('admin.media.view.label'),
    items: [
      { href: viewHref('grid'), label: t('admin.media.view.grid'), current: data.view === 'grid' },
      { href: viewHref('list'), label: t('admin.media.view.list'), current: data.view === 'list' },
    ],
  }}
  empty={data.items.length === 0
    ? data.q
      ? { title: fill(t('admin.media.search.none'), { q: data.q }) }
      : { title: t('admin.media.none'), body: t('admin.media.none.body') }
    : undefined}
  paging={data.nextCursor ? { next: query(data.view, { cursor: data.nextCursor }) } : undefined}
>
  {#snippet notices()}
    {#if failed}
      <Notice tone="error" title={t('error.summary.title')}>
        <p>{failure}</p>
        {#if refused(failed).length}
          <ul>
            {#each refused(failed) as r, i (i)}<li>{refusal(r)}</li>{/each}
          </ul>
        {/if}
      </Notice>
    {/if}
    {#if done && refused(done).length}
      <Notice tone="error" title={t('admin.media.refused')}>
        <ul>
          {#each refused(done) as r, i (i)}<li>{refusal(r)}</li>{/each}
        </ul>
      </Notice>
    {/if}
    {#if done}
      <Notice tone="success">
        <p>
          {fill(t(done.done), {
            filename: filenameOf(done),
            n: 'n' in done ? String(done.n) : '',
          })}
        </p>
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
    <Dialog
      id="media-upload"
      title={t('admin.media.upload.title')}
      trigger={t('admin.media.upload.add')}
      locale={data.locale}
    >
      <form method="post" action="?/upload" enctype="multipart/form-data">
        <Fieldset legend={t('admin.media.upload.title')}>
          <FileDrop
            id="upload-file"
            name="file"
            label={t('admin.media.upload.files')}
            multiple
            locale={data.locale}
            accept="image/jpeg,image/png,image/webp,image/avif,image/gif,application/pdf"
            hint={fill(t('admin.media.upload.hint'), { max: size(data.maxUploadBytes) })}
            required
            preview
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
    </Dialog>
    <UploadDropZone
      url="{base}/media/upload"
      locale={data.locale}
      hint={fill(t('admin.media.upload.hint'), { max: size(data.maxUploadBytes) })}
    />
    {#if data.storage}
      <p class="ui-hint" data-media-storage>
        {fill(t('admin.media.storage'), {
          used: size(data.storage.usedBytes),
          max: size(data.storage.maxBytes),
        })}
      </p>
    {/if}
  {/snippet}

  {#snippet filters()}
    <form method="get" role="search" class="ui-library-search">
      {#if data.view === 'list'}<input type="hidden" name="view" value="list" />{/if}
      <Field
        id="media-search"
        name="q"
        type="search"
        value={data.q}
        label={t('admin.media.search.label')}
        locale={data.locale}
      />
      <div class="ui-actions">
        <Button variant="secondary">{t('admin.media.search.submit')}</Button>
        {#if data.q}
          <Button variant="link" href={data.view === 'list' ? '?view=list' : '?'}
            >{t('admin.media.search.clear')}</Button
          >
        {/if}
      </div>
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
                  src={thumbPath(base, m.id)}
                  alt=""
                  width={THUMB.row.width}
                  height={THUMB.row.height}
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
              <img
                src={thumbPath(base, m.id)}
                alt=""
                width={THUMB.card.width}
                height={THUMB.card.height}
                loading="lazy"
              />
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
