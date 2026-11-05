<!-- The content list (TODO #11 A1, brief #56 § C2) on the overview pattern: pages and articles
     are separate menu items (editor trial 2026-10-28), one table row per item in the content
     locale (#66 PR 4): its title, one status badge, and the other locales as links to that
     translation, with a word where it is behind or missing (a dot alone says nothing to touch or
     a keyboard). Above the table the filter bar of the audit log: a search and one status in a
     GET form; the column headings sort. Every view is a link built by the route, so the list
     works without JavaScript; the table scrolls inside its own region on a narrow screen, never
     the page. The page title is the one visible heading (#87); "updated" is relative in the
     operator's zone, the full moment in its title. A row carries its item's id, so the way back
     from an item lands on it. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Field,
    Notice,
    OverviewPage,
    Select,
    Table,
  } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/content`);
  const status = (s: string) => t(`admin.content.status.${s}` as UiKey);
  const TONE = {
    draft: 'neutral',
    scheduled: 'info',
    published: 'success',
    unpublished: 'warning',
    changed: 'warning',
    missing: 'neutral',
  } as const;
  const tone = (s: string) => TONE[s as keyof typeof TONE] ?? 'neutral';
  // The admin renders on the server only (csr = false), so `now` is the moment of the request.
  const now = new Date();
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
  const kind = $derived(
    t(data.type === 'page' ? 'admin.content.filter.page' : 'admin.content.filter.article')
  );
  const number = (n: number) => new Intl.NumberFormat(data.locale).format(n);
  const plural = (
    key: 'admin.content.list.found' | `admin.content.list.count.${'page' | 'article'}`,
    n: number
  ) => fill(t(`${key}.${n === 1 ? 'one' : 'other'}` as const), { n: number(n) });
  const count = $derived(
    data.filtered
      ? plural('admin.content.list.found', data.total)
      : plural(`admin.content.list.count.${data.type}`, data.total)
  );
  const nothing = $derived(
    data.view.q
      ? fill(t('admin.content.list.none.q'), { q: data.view.q })
      : t('admin.content.list.none')
  );
</script>

<svelte:head>
  <title>{kind} · {data.tenant.name} · {t('admin.title')}</title>
</svelte:head>

<OverviewPage
  title={kind}
  locale={data.locale}
  breadcrumb={[{ label: data.tenant.name, href: `/admin/${data.tenant.slug}` }, { label: kind }]}
  listTitle={kind}
  empty={data.items.length > 0
    ? undefined
    : data.filtered
      ? { title: nothing, body: t('admin.content.list.none.body') }
      : { title: t('admin.content.empty') }}
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
    {#if form}<Notice tone="error"><p>{t(form.error)}</p></Notice>{/if}
  {/snippet}
  {#snippet actions()}
    <form method="POST" action="?/create">
      <input type="hidden" name="type" value={data.type} /><Button
        >{t(`admin.content.new.${data.type}`)}</Button
      >
    </form>
  {/snippet}
  {#snippet filters()}
    <form
      method="get"
      role="search"
      class="ui-filter-bar"
      aria-label={t('admin.content.list.filter')}
    >
      {#each data.keep as [name, value] (name)}<input type="hidden" {name} {value} />{/each}
      <Field
        id="content-q"
        name="q"
        type="search"
        size="m"
        value={data.view.q}
        label={t('admin.content.list.search')}
        locale={data.locale}
      />
      <Select
        id="content-status"
        name="status"
        size="m"
        value={data.view.status ?? ''}
        options={[
          { value: '', label: t('admin.content.list.status.all') },
          ...data.statuses.map((s) => ({
            value: s,
            label: t(`admin.content.list.status.${s}` as const),
          })),
        ]}
        label={t('admin.content.state')}
        locale={data.locale}
      />
      <Actions>
        <Button variant="secondary">{t('admin.content.list.submit')}</Button>
        {#if data.filtered}
          <Button variant="link" href={data.links.clear}>{t('admin.content.list.clear')}</Button>
        {/if}
      </Actions>
    </form>
    <p class="ui-list-count" id="content-count">{count}</p>
  {/snippet}

  <Table
    id="content-table"
    caption={kind}
    hideCaption
    level
    columns={[
      { key: 'title', label: t('admin.content.field.title'), sortable: true },
      { key: 'status', label: t('admin.content.state') },
      { key: 'updated', label: t('admin.content.column.updated'), sortable: true },
    ]}
    sort={{ key: data.view.sort, dir: data.view.dir }}
    sortHref={(key, dir) => data.links.sort[key]?.[dir] ?? data.links.clear}
  >
    {#snippet rows()}
      {#each data.items as item (item.id)}
        {@const updated = when(item.updated)}
        <tr id="item-{item.id}">
          <th scope="row"
            ><a
              href="{base}/{item.id}"
              lang={item.titleLocale && item.titleLocale !== data.workLocale
                ? item.titleLocale
                : undefined}>{item.title || t('admin.content.untitled')}</a
            ></th
          >
          <td>
            <Badge tone={tone(item.status)}>{status(item.status)}</Badge>
            {#if item.others.length}
              <ul class="ui-locale-codes">
                {#each item.others as o (o.locale)}
                  <li>
                    <a href="{base}/{item.id}?locale={o.locale}">{o.locale}</a
                    >{#if o.state !== 'ok'}<span class="ui-locale-dot {o.state}" aria-hidden="true"
                      ></span>{t(`admin.content.list.locale.${o.state}` as const)}{/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </td>
          <td><time datetime={updated.iso} title={updated.full}>{updated.text}</time></td>
        </tr>
      {/each}
    {/snippet}
  </Table>
</OverviewPage>
