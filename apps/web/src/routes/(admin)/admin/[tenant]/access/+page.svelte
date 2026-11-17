<!-- A tier has no delete (core: a removed tier could widen what is published), so a row only opens its form. -->
<script lang="ts">
  import { pickAny } from '@mycel/core';
  import { OverviewPage, Button, Table } from '#lib/admin/ui/index.js';
  import { ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/access`);
</script>

<svelte:head><title>{t('admin.tiers.title')} · {data.tenant.name}</title></svelte:head>
<OverviewPage
  title={t('admin.tiers.title')}
  description={t('admin.tiers.intro')}
  locale={data.locale}
  listTitle={t('admin.tiers.title')}
  empty={data.tiers.length ? undefined : { title: t('admin.tiers.empty') }}
>
  {#snippet actions()}{#if data.write}<Button href="{base}/new">{t('admin.tiers.new')}</Button
      >{/if}{/snippet}
  <Table
    id="tiers"
    caption={t('admin.tiers.title')}
    hideCaption
    stack
    card
    columns={[
      { key: 'name', label: t('admin.tiers.name') },
      { key: 'kind', label: t('admin.tiers.kind') },
      { key: 'order', label: t('admin.tiers.order') },
    ]}
  >
    {#snippet rows()}{#each data.tiers as tier (tier.id)}<tr>
          <th scope="row" data-label={t('admin.tiers.name')}
            >{#if data.write}<a href="{base}/{tier.id}"
                >{pickAny(tier.name, data.contentLocale) ?? tier.slug}</a
              >{:else}{pickAny(tier.name, data.contentLocale) ?? tier.slug}{/if}</th
          >
          <td data-label={t('admin.tiers.kind')}>{t(`admin.tiers.kind.${tier.kind}`)}</td>
          <td data-label={t('admin.tiers.order')}>{tier.order}</td>
        </tr>{/each}{/snippet}
  </Table>
</OverviewPage>
