<!-- One register for people and organisations, using the shared stacked table and action groups. -->
<script lang="ts">
  import { OverviewPage, Actions, Button, Field, Select, Table } from '#lib/admin/ui/index.js';
  import { ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/people`);
  const page = (offset: number) =>
    `${base}?${new URLSearchParams({ q: data.q, kind: data.kind, group: data.group, offset: String(offset) })}`;
</script>

<svelte:head><title>{t('admin.people.title')} · {data.tenant.name}</title></svelte:head>
<OverviewPage
  title={t('admin.people.title')}
  locale={data.locale}
  listTitle={t('admin.people.title')}
  empty={data.people.length ? undefined : { title: t('admin.people.empty') }}
  paging={{
    ...(data.offset > 0 ? { previous: page(Math.max(0, data.offset - 50)) } : {}),
    ...(data.offset + 50 < data.total ? { next: page(data.offset + 50) } : {}),
  }}
>
  {#snippet actions()}
    {#if data.write}<Button href="{base}/new">{t('admin.people.new')}</Button><Button
        href="{base}/new?kind=organisation">{t('admin.people.newOrganisation')}</Button
      >{/if}
    <Button variant="secondary" href="{base}/groups">{t('admin.people.groups')}</Button>
  {/snippet}
  {#snippet filters()}<form method="get" class="ui-fields">
      <Field
        id="people-search"
        name="q"
        type="search"
        label={t('admin.people.search')}
        locale={data.locale}
        value={data.q}
      />
      <Select
        id="people-kind"
        name="kind"
        label={t('admin.people.type')}
        locale={data.locale}
        value={data.kind}
        options={[
          { value: '', label: t('admin.people.type.all') },
          { value: 'person', label: t('admin.people.type.person') },
          { value: 'organisation', label: t('admin.people.type.organisation') },
        ]}
      />
      <Select
        id="people-group"
        name="group"
        label={t('admin.people.groups')}
        locale={data.locale}
        value={data.group}
        options={[
          { value: '', label: t('admin.people.allGroups') },
          ...data.groups.map((g) => ({ value: g.id, label: g.name })),
        ]}
      />
      <Actions
        ><Button>{t('admin.people.filter')}</Button><Button variant="link" href={base}
          >{t('admin.people.clear')}</Button
        ></Actions
      >
    </form>{/snippet}
  <Table
    id="people"
    caption={t('admin.people.title')}
    hideCaption
    stack
    card
    columns={[
      { key: 'name', label: t('admin.people.name') },
      { key: 'kind', label: t('admin.people.type') },
      { key: 'page', label: t('admin.people.pagePolicy') },
    ]}
  >
    {#snippet rows()}{#each data.people as person}
        <tr
          ><th scope="row" data-label={t('admin.people.name')}
            >{#if data.write}<a href="{base}/{person.id}">{person.name}</a
              >{:else}{person.name}{/if}</th
          >
          <td data-label={t('admin.people.type')}>{t(`admin.people.type.${person.kind}`)}</td>
          <td data-label={t('admin.people.pagePolicy')}
            >{t(`admin.people.status.${data.statuses[person.id] ?? 'no-articles'}`)}</td
          ></tr
        >
      {/each}{/snippet}
  </Table>
</OverviewPage>
