<!-- Group order and membership are edited together, on the group's timestamp. -->
<script lang="ts">
  import { pickAny } from '@mycel/core';
  import { OverviewPage, Button, Table } from '#lib/admin/ui/index.js';
  import { ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/people`);
</script>

<svelte:head><title>{t('admin.people.groups')} · {data.tenant.name}</title></svelte:head>
<OverviewPage
  title={t('admin.people.groups')}
  locale={data.locale}
  listTitle={t('admin.people.groups')}
  empty={data.groups.length ? undefined : { title: t('admin.people.emptyGroups') }}
>
  {#snippet actions()}{#if data.write}<Button href="{base}/groups/new"
        >{t('admin.people.newGroup')}</Button
      >{/if}<Button variant="link" href={base}>{t('admin.people.cancel')}</Button>{/snippet}
  <Table
    id="groups"
    caption={t('admin.people.groups')}
    hideCaption
    stack
    card
    columns={[
      { key: 'name', label: t('admin.people.name') },
      { key: 'order', label: t('admin.people.order') },
    ]}
  >
    {#snippet rows()}{#each data.groups as group}<tr>
          <td data-label={t('admin.people.name')}
            >{#if data.write}<a class="ui-button link" href="{base}/groups/{group.id}"
                >{pickAny(group.name, data.contentLocale)}</a
              >{:else}{pickAny(group.name, data.contentLocale)}{/if}</td
          >
          <td data-label={t('admin.people.order')}>{group.order}</td>
        </tr>{/each}{/snippet}
  </Table>
</OverviewPage>
