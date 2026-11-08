<!-- The content list (TODO #11 A1, brief #56 § C2) on the overview pattern: pages and articles
     are separate menu items (editor trial 2026-10-28), one table row per item in the content
     locale (#66 PR 4): its title, one status badge, and the other locales as links to that
     translation, with a word where it is behind or missing (a dot alone says nothing to touch or
     a keyboard). Above the table the filter bar of the audit log: a search and one status in a
     GET form, and behind "more filters" the rest of what a list can be narrowed by, each filter
     that is on a chip that takes it off; the column headings sort, and a person picks the columns
     and the page size (`content-list.ts`). Every view is a link built by the route, so the list
     works without JavaScript; the table scrolls inside its own region on a narrow screen, never
     the page. The page title is the one visible heading (#87); "updated" is relative in the
     operator's zone, the full moment in its title. A row carries its item's id, so the way back
     from an item lands on it. A row's actions post through one form outside the table,
     which no form can wrap; `RowActions` says how they show per width. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Choices,
    ConfirmAction,
    Field,
    FilterChips,
    Notice,
    OverviewPage,
    RowActions,
    Select,
    Table,
  } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  import AdminScript from '#lib/admin/trusted/AdminScript.svelte';
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
  // Without any, a reader would open a menu with nothing in it. Taking offline needs a live page.
  const nameOf = (item: (typeof data.items)[number]) => item.title || t('admin.content.untitled');
  const hasActions = (item: (typeof data.items)[number]) =>
    Boolean(item.live || item.preview || data.canWrite);
  // A page on which no row has any keeps no column for them: without the row's actions the table
  // is no container, so an empty column would never give way below 58rem.
  const canBulk = $derived(data.canPublish || (data.type === 'article' && data.canWrite));
  const anyActions = $derived(data.items.some(hasActions));
  const columnLabel = (column: (typeof data.columnChoices)[number]) =>
    t(`admin.content.list.column.${column}` as const);
  /** A day of the filter, as the operator reads dates: it is a calendar day, so no zone. */
  const dayText = (value: string) =>
    new Intl.DateTimeFormat(data.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
      Date.parse(`${value}T00:00:00Z`)
    );
  const chipValue = (chip: (typeof data.chips)[number]) =>
    chip.name === 'status' && data.view.status
      ? t(`admin.content.list.status.${data.view.status}` as const)
      : chip.name === 'translation' && data.view.translation
        ? t(`admin.content.list.locale.${data.view.translation}` as const)
        : chip.name === 'from' || chip.name === 'to'
          ? dayText(chip.value)
          : chip.value;
  // The filters behind the fold stay in view while one of them is on.
  const moreOn = $derived(data.chips.some((chip) => chip.name !== 'q' && chip.name !== 'status'));
  const nothing = $derived(
    data.view.q
      ? fill(t('admin.content.list.none.q'), { q: data.view.q })
      : t('admin.content.list.none')
  );
</script>

{#snippet create()}
  <form method="POST" action="?/create">
    <input type="hidden" name="type" value={data.type} /><Button
      >{t(`admin.content.new.${data.type}`)}</Button
    >
  </form>
{/snippet}

{#snippet rowActions(item: (typeof data.items)[number])}
  {@const name = item.title || t('admin.content.untitled')}
  {#if item.live}
    <a
      class="ui-button link"
      href={item.live}
      target="_blank"
      aria-label="{t('admin.content.row.site')}: {name}"
      aria-describedby="new-tab">{t('admin.content.row.site')}</a
    >
  {/if}
  {#if item.preview}
    <a
      class="ui-button link"
      href={item.preview}
      target="_blank"
      aria-label="{t('admin.content.row.preview')}: {name}"
      aria-describedby="new-tab">{t('admin.content.row.preview')}</a
    >
  {/if}
  {#if data.canWrite}
    <button
      class="ui-button link"
      type="submit"
      form="content-row-actions"
      formaction={data.links.duplicate}
      name="item"
      value={item.id}
      aria-label="{t('admin.content.row.duplicate')}: {name}"
      >{t('admin.content.row.duplicate')}</button
    >
  {/if}
  {#if data.canPublish && item.live}
    <ConfirmAction
      variant="link"
      label={t('admin.content.action.unpublish')}
      question={fill(t('admin.content.row.offline.question'), { locale: data.workLocale })}
      confirm={t('admin.content.row.offline.confirm')}
      {name}
      form="content-row-actions"
      formaction={data.links.unpublish}
      field={{ name: 'item', value: item.id }}
    />
  {/if}
{/snippet}

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
    : data.tooBroad
      ? {
          title: t('admin.content.list.tooBroad'),
          body: fill(t('admin.content.list.tooBroad.body'), { limit: number(data.walkLimit) }),
        }
      : data.filtered
        ? { title: nothing, body: t('admin.content.list.none.body') }
        : {
            title: t(`admin.content.empty.${data.type}`),
            body: data.canWrite ? t(`admin.content.empty.${data.type}.body`) : undefined,
            action: data.canWrite ? create : undefined,
          }}
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
    {#if data.offline}<Notice tone="success"
        ><p>
          {fill(t('admin.content.publication.done.unpublish'), { locale: data.workLocale })}
        </p></Notice
      >{/if}
  {/snippet}
  {#snippet actions()}
    <!-- An empty list offers this once, where the reader is looking. -->
    {#if data.canWrite && (data.total > 0 || data.filtered)}{@render create()}{/if}
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
      <details class="ui-fold ui-filter-more" open={moreOn}>
        <summary>{t('admin.content.list.more')}</summary>
        <div class="ui-filter-more-fields">
          {#if data.type === 'article'}
            <Select
              id="content-author"
              name="author"
              size="m"
              value={data.view.author ?? ''}
              options={[
                { value: '', label: t('admin.content.list.author.all') },
                ...data.authors.map((a) => ({ value: a.id, label: a.name })),
              ]}
              label={t('admin.content.list.column.author')}
              locale={data.locale}
            />
            <Select
              id="content-section"
              name="section"
              size="m"
              value={data.view.section ?? ''}
              options={[
                { value: '', label: t('admin.content.list.section.all') },
                ...data.sections.map((s) => ({ value: s.id, label: s.name })),
              ]}
              label={t('admin.content.list.column.section')}
              locale={data.locale}
            />
            <Field
              id="content-tag"
              name="tag"
              size="m"
              value={data.view.tag}
              label={t('admin.content.list.tag')}
              locale={data.locale}
            />
          {/if}
          <Field
            id="content-from"
            name="from"
            type="date"
            size="m"
            value={data.view.from}
            label={t('admin.content.list.from')}
            locale={data.locale}
          />
          <Field
            id="content-to"
            name="to"
            type="date"
            size="m"
            value={data.view.to}
            label={t('admin.content.list.to')}
            locale={data.locale}
          />
          {#if data.multi}
            <Select
              id="content-translation"
              name="translation"
              size="m"
              value={data.view.translation ?? ''}
              options={[
                { value: '', label: t('admin.content.list.translation.all') },
                ...data.translations.map((state) => ({
                  value: state,
                  label: t(`admin.content.list.translation.${state}` as const),
                })),
              ]}
              label={t('admin.content.list.translation')}
              locale={data.locale}
            />
          {/if}
        </div>
      </details>
      <Actions>
        <Button variant="secondary">{t('admin.content.list.submit')}</Button>
        {#if data.filtered}
          <Button variant="link" href={data.links.clear}>{t('admin.content.list.clear')}</Button>
        {/if}
      </Actions>
    </form>
    {#if data.chips.length}
      <FilterChips
        label={t('admin.content.list.chips')}
        items={data.chips.map((chip) => {
          const label = `${t(`admin.content.list.chip.${chip.name}` as const)}: ${chipValue(chip)}`;
          return {
            label,
            href: chip.href,
            remove: fill(t('admin.content.list.chip.remove'), { filter: label }),
          };
        })}
      />
    {/if}
    <div class="ui-list-tools">
      <!-- A refused filter counted nothing, so it says no number. -->
      {#if !data.tooBroad}<p class="ui-list-count" id="content-count">{count}</p>{/if}
      <details class="ui-fold ui-list-display">
        <summary>{t('admin.content.list.display')}</summary>
        <form method="POST" action={data.links.display} class="ui-list-display-form">
          <Choices
            id="content-columns"
            name="column"
            type="checkbox"
            legend={t('admin.content.list.display.columns')}
            locale={data.locale}
            selected={data.display.columns}
            options={data.columnChoices.map((column) => ({
              value: column,
              label: columnLabel(column),
            }))}
          />
          <Select
            id="content-per"
            name="per"
            size="xs"
            value={String(data.display.per)}
            options={data.pageSizes.map((size) => ({
              value: String(size),
              label: String(size),
            }))}
            label={t('admin.content.list.display.per')}
            locale={data.locale}
          />
          <Actions>
            <Button variant="secondary">{t('admin.content.list.display.save')}</Button>
          </Actions>
        </form>
      </details>
    </div>
  {/snippet}

  <p id="new-tab" class="ui-visually-hidden">{t('admin.content.edit.newTab')}</p>
  <form id="content-row-actions" method="POST">
    <input type="hidden" name="locale" value={data.workLocale} />
  </form>
  {#if data.items.length && canBulk}
    <form
      id="content-bulk"
      data-bulk-form
      method="POST"
      action={data.links.bulk}
      class="ui-list-display-form"
    >
      <h2>{t('admin.content.bulk.title')}</h2>
      <p>{t('admin.content.bulk.scope')}</p>
      <div class="ui-choice">
        <input id="bulk-all" type="checkbox" name="all" value="yes" />
        <label for="bulk-all">{t('admin.content.bulk.all')}</label>
      </div>
      <p data-bulk-count data-template={t('admin.content.bulk.count')} aria-live="polite"></p>
      <Select
        id="bulk-operation"
        name="operation"
        label={t('admin.content.bulk.operation')}
        locale={data.locale}
        options={[
          ...(data.canPublish
            ? [
                { value: 'publish', label: t('admin.content.action.publish') },
                { value: 'unpublish', label: t('admin.content.action.unpublish') },
              ]
            : []),
          ...(data.type === 'article' && data.canWrite
            ? [{ value: 'section', label: t('admin.content.bulk.section') }]
            : []),
        ]}
      />
      <Select
        id="bulk-locale"
        name="locale"
        label={t('admin.content.bulk.locale')}
        locale={data.locale}
        value={data.workLocale}
        options={data.tenant.locales.map((l) => ({ value: l, label: l }))}
      />
      {#if data.type === 'article' && data.canWrite}
        <Select
          id="bulk-section"
          name="section"
          label={t('admin.content.bulk.section')}
          locale={data.locale}
          options={[
            { value: '', label: t('admin.content.bulk.noSection') },
            ...data.sections.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
      {/if}
      <Actions><Button variant="secondary">{t('admin.content.bulk.preview')}</Button></Actions>
    </form>
    <AdminScript src="/_admin/content-bulk.js" />
  {/if}
  <Table
    id="content-table"
    caption={kind}
    hideCaption
    level
    columns={[
      { key: 'title', label: t('admin.content.field.title'), sortable: true },
      ...data.display.columns.map((column) => ({
        key: column,
        label: columnLabel(column),
        sortable: column === 'updated' || column === 'created',
      })),
      ...(anyActions
        ? [
            {
              key: 'actions',
              label: t('admin.content.list.column.actions'),
              class: 'ui-row-actions-cell',
            },
          ]
        : []),
    ]}
    sort={{ key: data.view.sort, dir: data.view.dir }}
    sortHref={(key, dir) => data.links.sort[key]?.[dir] ?? data.links.clear}
  >
    {#snippet rows()}
      {#each data.items as item (item.id)}
        <tr id="item-{item.id}">
          <!-- Named by the title alone: from its content the row header would read the menu along. -->
          <th scope="row" aria-labelledby="title-{item.id}"
            ><a
              id="title-{item.id}"
              href="{base}/{item.id}"
              lang={item.titleLocale && item.titleLocale !== data.workLocale
                ? item.titleLocale
                : undefined}>{item.title || t('admin.content.untitled')}</a
            >
            {#if canBulk}
              <div class="ui-choice">
                <input type="hidden" form="content-bulk" name="visible" value={item.id} />
                <input
                  type="hidden"
                  form="content-bulk"
                  name="base-{item.id}"
                  value={item.latestRevisionId}
                />
                <input
                  id="select-{item.id}"
                  type="checkbox"
                  form="content-bulk"
                  name="selected"
                  value={item.id}
                />
                <label for="select-{item.id}"
                  >{fill(t('admin.content.bulk.select'), { title: nameOf(item) })}</label
                >
              </div>
            {/if}
            {#if hasActions(item)}
              <RowActions
                menu={t('admin.content.row.menu')}
                name={item.title || t('admin.content.untitled')}
                >{@render rowActions(item)}</RowActions
              >
            {/if}</th
          >
          {#each data.display.columns as column (column)}
            <td>
              {#if column === 'status'}
                <Badge tone={tone(item.status)}>{status(item.status)}</Badge>
                {#if item.others.length}
                  <ul class="ui-locale-codes">
                    {#each item.others as o (o.locale)}
                      <li>
                        <a href="{base}/{item.id}?locale={o.locale}">{o.locale}</a
                        >{#if o.state !== 'ok'}<span
                            class="ui-locale-dot {o.state}"
                            aria-hidden="true"
                          ></span>{t(`admin.content.list.locale.${o.state}` as const)}{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              {:else if column === 'author'}
                {item.authors.join(', ')}
              {:else if column === 'section'}
                {item.section ?? ''}
              {:else if column === 'tags'}
                {item.tags.join(', ')}
              {:else if column === 'slug'}
                {item.slug}
              {:else}
                {@const moment = when(column === 'created' ? item.created : item.updated)}
                <time datetime={moment.iso} title={moment.full}>{moment.text}</time>
              {/if}
            </td>
          {/each}
          {#if anyActions}
            <td class="ui-row-actions-cell"
              >{#if hasActions(item)}<RowActions>{@render rowActions(item)}</RowActions>{/if}</td
            >
          {/if}
        </tr>
      {/each}
    {/snippet}
  </Table>
</OverviewPage>
