<!-- The media library starts with its assets, not a full-page upload form (TODO #10b). A compact
     button opens the native upload dialog; a window-wide drop enhancement reports progress and
     per-file failures, then refreshes the server-rendered library. Above the assets the filter bar
     of the content list: a search, a type, what needs attention and an order in one GET form, each
     filter that is on a chip that takes it off. An order sits in the form because a grid has no
     column headings to click; the table has both. Everything remains usable without JavaScript;
     media.spec.ts checks both paths and reflow. -->
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
    FilterChips,
    Notice,
    OverviewPage,
    Select,
    Table,
    ViewSwitch,
  } from '#lib/admin/ui/index.js';
  import { formatBytes, formatWhen } from '#lib/admin/format.js';
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
  const number = (n: number) => new Intl.NumberFormat(data.locale).format(n);
  const count = $derived(
    fill(
      t(
        data.filtered
          ? (`admin.content.list.found.${data.total === 1 ? 'one' : 'other'}` as const)
          : (`admin.media.list.count.${data.total === 1 ? 'one' : 'other'}` as const)
      ),
      { n: number(data.total) }
    )
  );
  const chipLabel = (chip: (typeof data.chips)[number]) =>
    chip.name === 'kind'
      ? `${t('admin.media.list.kind')}: ${t(`admin.media.list.kind.${data.view.kind!}` as const)}`
      : chip.name === 'show'
        ? `${t('admin.media.list.show')}: ${t(`admin.media.list.show.${data.view.show!}` as const)}`
        : `${t('admin.content.list.chip.q')}: ${chip.value}`;
  // The admin renders on the server only (csr = false), so `now` is the moment of the request.
  const now = new Date();
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
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
  empty={data.items.length === 0
    ? data.filtered
      ? {
          title: data.view.q
            ? fill(t('admin.media.search.none'), { q: data.view.q })
            : t('admin.content.list.none'),
          body: t('admin.content.list.none.body'),
        }
      : { title: t('admin.media.none'), body: t('admin.media.none.body') }
    : undefined}
  paging={data.links.previous || data.links.next
    ? {
        previous: data.links.previous,
        next: data.links.next,
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

  {#snippet actions()}
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
            accept="image/jpeg,image/png,image/webp,image/avif,image/gif,application/pdf,audio/mpeg"
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
  {/snippet}

  {#snippet intro()}
    <UploadDropZone
      url="{base}/media/upload"
      locale={data.locale}
      hint={fill(t('admin.media.upload.hint'), { max: size(data.maxUploadBytes) })}
    />
  {/snippet}

  {#snippet filters()}
    <div class="ui-filter-row">
      <form
        method="get"
        role="search"
        class="ui-filter-bar"
        aria-label={t('admin.content.list.filter')}
      >
        {#each data.keep as [name, value] (name)}<input type="hidden" {name} {value} />{/each}
        <Field
          id="media-search"
          name="q"
          type="search"
          size="m"
          value={data.view.q}
          label={t('admin.media.search.label')}
          locale={data.locale}
        />
        <Select
          id="media-kind"
          name="kind"
          size="m"
          value={data.view.kind ?? ''}
          options={[
            { value: '', label: t('admin.media.list.kind.all') },
            ...data.kinds.map((kind) => ({
              value: kind,
              label: t(`admin.media.list.kind.${kind}` as const),
            })),
          ]}
          label={t('admin.media.list.kind')}
          locale={data.locale}
        />
        <Select
          id="media-show"
          name="show"
          size="m"
          value={data.view.show ?? ''}
          options={[
            { value: '', label: t('admin.media.list.show.all') },
            ...data.shows.map((show) => ({
              value: show,
              label: t(`admin.media.list.show.${show}` as const),
            })),
          ]}
          label={t('admin.media.list.show')}
          locale={data.locale}
        />
        <Select
          id="media-order"
          name="sort"
          size="m"
          value={data.view.order}
          options={data.orders.map((order) => ({
            value: order,
            label: t(`admin.media.list.order.${order}` as const),
          }))}
          label={t('admin.media.list.order')}
          locale={data.locale}
        />
        <Actions>
          <Button variant="secondary">{t('admin.content.list.submit')}</Button>
          {#if data.filtered}
            <Button variant="link" href={data.links.clear}>{t('admin.content.list.clear')}</Button>
          {/if}
        </Actions>
      </form>
      <ViewSwitch
        label={t('admin.media.view.label')}
        items={[
          {
            href: data.links.grid,
            label: t('admin.media.view.grid'),
            current: data.view.layout === 'grid',
          },
          {
            href: data.links.list,
            label: t('admin.media.view.list'),
            current: data.view.layout === 'list',
          },
        ]}
      />
    </div>
    {#if data.chips.length}
      <FilterChips
        label={t('admin.content.list.chips')}
        items={data.chips.map((chip) => ({
          label: chipLabel(chip),
          href: chip.href,
          remove: fill(t('admin.content.list.chip.remove'), { filter: chipLabel(chip) }),
        }))}
      />
    {/if}
    <div class="ui-list-tools">
      <p class="ui-list-count" id="media-count">{count}</p>
      {#if data.storage}
        <p class="ui-hint" data-media-storage>
          {fill(t('admin.media.storage'), {
            used: size(data.storage.usedBytes),
            max: size(data.storage.maxBytes),
          })}
        </p>
      {/if}
    </div>
  {/snippet}

  {#if data.view.layout === 'list'}
    <Table
      id="media-table"
      caption={t('admin.media.library')}
      columns={[
        { key: 'thumb', label: t('admin.media.preview') },
        { key: 'name', label: t('admin.media.filename'), sortable: true },
        { key: 'dimensions', label: t('admin.media.dimensions') },
        { key: 'size', label: t('admin.media.size'), numeric: true, sortable: true },
        { key: 'usage', label: t('admin.media.usage') },
        { key: 'access', label: t('admin.media.access') },
        { key: 'created', label: t('admin.media.uploaded'), sortable: true },
      ]}
      sort={{ key: data.view.sort, dir: data.view.dir }}
      sortHref={(key, dir) => data.links.sort[`${key}-${dir}`] ?? data.links.clear}
    >
      {#snippet rows()}
        {#each data.items as m (m.id)}
          {@const moment = when(m.createdAt)}
          <tr id="media-{m.id}">
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
            <td><time datetime={moment.iso} title={moment.full}>{moment.text}</time></td>
          </tr>
        {/each}
      {/snippet}
    </Table>
  {:else}
    <CardGrid
      items={data.items}
      key={(m) => m.id}
      itemId={(m) => `media-${m.id}`}
      label={t('admin.media.library')}
    >
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
