<!-- The site's supporters as a list (brief MY-251): address, lists, first seen and last activity,
     on the shared overview pattern and stacked table, so nothing scrolls sideways at 320 CSS px.
     The filter is a plain GET form and paging is links: the page works without JavaScript. A list
     someone signed up for but has not confirmed is marked in words, not by colour alone. The
     filter's two actions stand in one wrapping group (skill ui-action-layout). The export is a
     form of its own below the count, apart from the filter's actions: it posts the filter in view,
     so it says what it takes. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Field,
    OverviewPage,
    Select,
    Table,
  } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { fill, plural, ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/supporters`);
  const listLabel = (id: string) => data.lists.find((l) => l.id === id)?.label ?? id;
  const now = new Date();
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
</script>

<svelte:head><title>{t('admin.supporters.title')} · {data.tenant.name}</title></svelte:head>
<OverviewPage
  title={t('admin.supporters.title')}
  locale={data.locale}
  description={t('admin.supporters.intro')}
  listTitle={t('admin.supporters.title')}
  empty={data.supporters.length
    ? undefined
    : {
        title: t(data.filtered ? 'admin.supporters.emptyFiltered' : 'admin.supporters.empty'),
        body: data.filtered ? undefined : t('admin.supporters.emptyBody'),
      }}
  paging={data.paging}
>
  {#snippet filters()}<form method="get" class="ui-fields">
      <Field
        id="supporters-search"
        name="q"
        type="search"
        label={t('admin.supporters.search')}
        locale={data.locale}
        value={data.q}
        autocomplete="off"
      />
      <Select
        id="supporters-list"
        name="list"
        label={t('admin.supporters.list')}
        locale={data.locale}
        value={data.list}
        options={[
          { value: '', label: t('admin.supporters.list.all') },
          ...data.lists.map((l) => ({ value: l.id, label: l.label })),
        ]}
      />
      <Select
        id="supporters-status"
        name="status"
        label={t('admin.supporters.status')}
        locale={data.locale}
        value={data.status}
        hint={t('admin.supporters.status.hint')}
        options={[
          { value: '', label: t('admin.supporters.status.all') },
          { value: 'confirmed', label: t('admin.supporters.status.confirmed') },
          { value: 'pending', label: t('admin.supporters.status.pending') },
        ]}
      />
      <Actions
        ><Button>{t('admin.supporters.filter')}</Button><Button variant="link" href={base}
          >{t('admin.supporters.clear')}</Button
        ></Actions
      >
    </form>
    <p class="supporters-count" role="status">
      {plural(t, 'admin.supporters.count', data.total)}
    </p>
    {#if data.canExport && data.total}<form method="post" action="{base}/export">
        <input type="hidden" name="q" value={data.q} />
        <input type="hidden" name="list" value={data.list} />
        <input type="hidden" name="status" value={data.status} />
        <Button variant="secondary">{t('admin.supporters.export')}</Button>
        {#if data.total > data.exportMax}<p class="ui-hint">
            {fill(t('admin.supporters.export.max'), {
              n: data.exportMax.toLocaleString(data.locale),
            })}
          </p>{/if}
      </form>{/if}{/snippet}
  <Table
    id="supporters"
    caption={t('admin.supporters.title')}
    hideCaption
    stack
    card
    columns={[
      { key: 'email', label: t('admin.supporters.email') },
      { key: 'lists', label: t('admin.supporters.lists') },
      { key: 'first', label: t('admin.supporters.firstSeen') },
      { key: 'last', label: t('admin.supporters.lastActivity') },
    ]}
  >
    {#snippet rows()}{#each data.supporters as s (s.id)}
        {@const first = when(s.firstSeen)}
        {@const last = when(s.lastActivity)}
        <tr
          ><th scope="row" data-label={t('admin.supporters.email')} class="supporters-email"
            ><a href="{base}/{s.id}">{s.email}</a></th
          >
          <td data-label={t('admin.supporters.lists')}
            >{#if s.lists.length || s.pendingLists.length}<ul class="supporters-lists">
                {#each s.lists as l (l)}<li>{listLabel(l)}</li>{/each}
                {#each s.pendingLists as l (l)}<li>
                    {listLabel(l)}
                    <Badge tone="warning">{t('admin.supporters.pending')}</Badge>
                  </li>{/each}
              </ul>{:else}{t('admin.supporters.noLists')}{/if}</td
          >
          <td data-label={t('admin.supporters.firstSeen')}
            ><time datetime={first.iso} title={first.full}>{first.text}</time></td
          >
          <td data-label={t('admin.supporters.lastActivity')}
            ><time datetime={last.iso} title={last.full}>{last.text}</time></td
          ></tr
        >
      {/each}{/snippet}
  </Table>
</OverviewPage>

<style>
  .supporters-email {
    overflow-wrap: anywhere;
  }
  .supporters-lists {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .supporters-count {
    margin-block: var(--space-2) 0;
  }
</style>
