<!-- The campaigns of a site on the overview pattern: per campaign its landing page's
     title (to the page's editor, where the campaign panel is), kind, participation, where the page
     is published and the count. One primary action: a new campaign, whose kind is chosen on the
     next screen. Native links and a plain table; nothing needs JavaScript. -->
<script lang="ts">
  import { pickAny } from '@mycel/core';
  import { Badge, Button, OverviewPage, Table } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const title = $derived(t('admin.campaign.title'));
  const number = (n: number) => n.toLocaleString(data.locale);
  const tone = { draft: 'neutral', open: 'success', closed: 'warning' } as const;
</script>

<svelte:head>
  <title>{title} · {data.tenant.name} · {t('admin.title')}</title>
</svelte:head>

{#snippet create()}
  <Button href="{base}/campaigns/new">{t('admin.campaign.new')}</Button>
{/snippet}

<OverviewPage
  {title}
  locale={data.locale}
  breadcrumb={[{ label: data.tenant.name, href: base }, { label: title }]}
  description={t('admin.campaign.intro')}
  listTitle={data.archived ? t('admin.campaign.archivedList') : title}
  empty={data.campaigns.length
    ? undefined
    : {
        title: t(data.archived ? 'admin.campaign.emptyArchived' : 'admin.campaign.empty'),
        icon: 'megaphone',
        body: data.archived ? undefined : t('admin.campaign.empty.body'),
        action: data.canCreate && !data.archived ? create : undefined,
      }}
>
  {#snippet actions()}
    {#if data.canCreate && data.campaigns.length}{@render create()}{/if}
    <Button
      variant="link"
      href={data.archived ? `${base}/campaigns` : `${base}/campaigns?archived=1`}
      >{t(data.archived ? 'admin.campaign.showActive' : 'admin.campaign.showArchived')}</Button
    >
  {/snippet}
  <Table
    id="campaigns"
    caption={data.archived ? t('admin.campaign.archivedList') : title}
    hideCaption={!data.archived}
    stack
    card
    level
    columns={[
      { key: 'title', label: t('admin.campaign.column.title') },
      { key: 'kind', label: t('admin.campaign.column.kind') },
      { key: 'state', label: t('admin.campaign.column.state') },
      { key: 'page', label: t('admin.campaign.column.page') },
      { key: 'count', label: t('admin.campaign.column.count'), numeric: true },
    ]}
  >
    {#snippet rows()}
      {#each data.campaigns as c (c.id)}
        <tr>
          <td data-label={t('admin.campaign.column.title')}>
            {#if c.landing}<a href="{base}/content/{c.landingItemId}"
                >{pickAny(c.landing.title, data.locale, data.tenant.defaultLocale) ??
                  c.landing.slug}</a
              >{:else}{t('admin.campaign.landingTrashed')}{/if}
          </td>
          <td data-label={t('admin.campaign.column.kind')}>{t(`admin.campaign.kind.${c.kind}`)}</td>
          <td data-label={t('admin.campaign.column.state')}
            ><Badge tone={tone[c.participation.state]}
              >{t(`admin.campaign.state.${c.participation.state}`)}</Badge
            ></td
          >
          <td data-label={t('admin.campaign.column.page')}>
            {c.landing?.published.length
              ? fill(t('admin.campaign.page.published'), {
                  locales: c.landing.published.join(', '),
                })
              : t('admin.campaign.page.draft')}
          </td>
          <td class="numeric" data-label={t('admin.campaign.column.count')}>
            {c.goal
              ? fill(t('admin.campaign.count.ofTarget'), {
                  count: number(c.participants),
                  target: number(c.goal.target),
                })
              : number(c.participants)}
          </td>
        </tr>
      {/each}
    {/snippet}
  </Table>
</OverviewPage>
