<!-- Who took part in one campaign (TODO MY-256 PR 2): address, when the participation was
     confirmed and whether it still counts, on the shared overview pattern and stacked table, so
     nothing scrolls sideways at 320 CSS px. Paging is links and the export a plain form post: the
     page works without JavaScript. A withdrawn participation is said in words, not by colour
     alone. One action, the export, in a form of its own below the count; the way back to the
     campaign is the breadcrumb. -->
<script lang="ts">
  import { Badge, Button, OverviewPage, Table } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { fill, plural, ui } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const title = $derived(t('admin.campaign.participants.title'));
  const campaign = $derived(
    data.campaign.landing ?? t(`admin.campaign.kind.${data.campaign.kind}`)
  );
  const withdrawn = $derived(data.total - data.active);
  const now = new Date();
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
</script>

<svelte:head><title>{title} · {campaign} · {data.tenant.name}</title></svelte:head>
<OverviewPage
  {title}
  locale={data.locale}
  breadcrumb={[
    { label: t('admin.campaign.title'), href: `${base}/campaigns` },
    { label: campaign, href: `${base}/content/${data.campaign.landingItemId}#campaign` },
    { label: title },
  ]}
  description={t('admin.campaign.participants.intro')}
  listTitle={title}
  empty={data.participants.length
    ? undefined
    : {
        title: t('admin.campaign.participants.empty'),
        body: t(
          data.campaign.kind === 'fundraiser'
            ? 'admin.campaign.participants.empty.fundraiser'
            : 'admin.campaign.participants.empty.body'
        ),
      }}
  paging={data.paging}
>
  {#snippet filters()}<p class="participants-count" role="status">
      {plural(t, 'admin.campaign.participants.count', data.active)}{#if withdrawn}, {fill(
          t('admin.campaign.participants.withdrawnCount'),
          { n: withdrawn.toLocaleString(data.locale) }
        )}{/if}
    </p>
    {#if data.canExport && data.total}<form
        method="post"
        action="{base}/campaigns/{data.campaign.id}/participants/export"
      >
        <Button variant="secondary">{t('admin.supporters.export')}</Button>
        {#if data.total > data.exportMax}<p class="ui-hint">
            {fill(t('admin.campaign.participants.export.max'), {
              n: data.exportMax.toLocaleString(data.locale),
            })}
          </p>{/if}
      </form>{/if}{/snippet}
  <Table
    id="participants"
    caption={title}
    hideCaption
    stack
    card
    columns={[
      { key: 'email', label: t('admin.supporters.email') },
      { key: 'confirmed', label: t('admin.campaign.participants.confirmed') },
      { key: 'status', label: t('admin.campaign.participants.status') },
    ]}
  >
    {#snippet rows()}{#each data.participants as p (p.supporterId)}
        {@const confirmed = when(p.confirmedAt)}
        <tr
          ><th scope="row" data-label={t('admin.supporters.email')} class="participants-email"
            ><a href="{base}/supporters/{p.supporterId}">{p.email}</a></th
          >
          <td data-label={t('admin.campaign.participants.confirmed')}
            ><time datetime={confirmed.iso} title={confirmed.full}>{confirmed.text}</time></td
          >
          <td data-label={t('admin.campaign.participants.status')}
            >{#if p.withdrawnAt}{@const gone = when(p.withdrawnAt)}<Badge tone="warning"
                >{t('admin.supporter.campaign.withdrawn')}</Badge
              >
              <time datetime={gone.iso} title={gone.full}>{gone.text}</time>{:else}{t(
                'admin.campaign.participants.counts'
              )}{/if}</td
          ></tr
        >
      {/each}{/snippet}
  </Table>
</OverviewPage>

<style>
  .participants-email {
    overflow-wrap: anywhere;
  }
  .participants-count {
    margin-block: 0;
  }
</style>
