<!-- One supporter (brief MY-251 PR 2): the address and when they were seen, their lists, the
     campaigns they took part in, the access they hold and a timeline of what they did, newest
     first, in the admin's zone. One thing changes here: an administrator gives or takes back
     access to a tier (ADR 016), each in a native dialog with a plain form post, so the page works
     without JavaScript; everyone else reads. The two triggers are one action group that stacks
     when narrow (skill ui-action-layout). Sections of the overview pattern with stacked tables,
     so nothing scrolls sideways at 320 CSS px; a state (awaiting confirmation, withdrawn,
     expired) is said in words, not by colour alone. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Dialog,
    Field,
    MetaList,
    Notice,
    PageHeader,
    Section,
    Select,
    StatusLine,
    Table,
  } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { eventSentence } from '#lib/admin/supporters/words.js';
  import { perInterval } from '#lib/admin/donations/giving.js';
  import { fill, plural, refusalCopy, ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const s = $derived(data.supporter);
  const now = new Date();
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
  const lists = $derived([
    ...s.lists.map((id) => ({ id, pending: false })),
    ...s.pendingLists.map((id) => ({ id, pending: true })),
  ]);
  const older = $derived(data.eventTotal - data.events.length);
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form && form.done ? form : null);
  const standing = $derived(data.access.filter((a) => a.standing));
  const zoneHint = $derived(
    `${t('admin.supporter.grant.until.hint')} ${t('admin.content.publication.zone')} ${data.timeZone}`
  );
</script>

<svelte:head
  ><title
    >{failed ? `${t('error.prefix')} ` : ''}{s.email} · {t('admin.supporters.title')} · {data.tenant
      .name}</title
  ></svelte:head
>

<main class="page admin">
  <PageHeader
    title={s.email}
    locale={data.locale}
    breadcrumb={[
      { label: data.tenant.name, href: base },
      { label: t('admin.supporters.title'), href: `${base}/supporters` },
      { label: s.email },
    ]}
    description={t('admin.supporter.intro')}
  />

  {#if failed}
    <Notice tone="error" title={t('error.summary.title')}><p>{refusalCopy(t, failed)}</p></Notice>
  {:else if done}
    <Notice tone="success"><p>{t(done.done)}</p></Notice>
  {/if}

  <Section id="supporter-facts" title={t('admin.supporter.facts')} locale={data.locale}>
    <MetaList
      items={[
        { term: t('admin.supporters.email'), value: s.email },
        { term: t('admin.supporters.firstSeen'), value: when(s.firstSeen).full },
        { term: t('admin.supporters.lastActivity'), value: when(s.lastActivity).full },
        ...(s.lastSeenAt
          ? [{ term: t('admin.supporter.lastSeen'), value: when(s.lastSeenAt).full }]
          : []),
      ]}
    />
    {#each data.giving as g (g.id)}<p>
        <a href="{base}/donations/recurring/{g.id}"
          >{fill(t(g.paused ? 'admin.supporter.givesPaused' : 'admin.supporter.gives'), {
            what: perInterval(t, g.amount, g.currency, g.interval, data.locale),
          })}</a
        >
      </p>{/each}
  </Section>

  <Section id="supporter-lists" title={t('admin.supporter.lists')} locale={data.locale}>
    {#if lists.length}
      <Table
        id="supporter-lists-table"
        caption={t('admin.supporter.lists')}
        hideCaption
        stack
        card
        level
        columns={[
          { key: 'list', label: t('admin.supporters.list') },
          { key: 'status', label: t('admin.supporters.status') },
        ]}
      >
        {#snippet rows()}{#each lists as l (l.id)}
            <tr
              ><th scope="row" data-label={t('admin.supporters.list')}
                >{data.names.lists[l.id] ?? l.id}</th
              >
              <td data-label={t('admin.supporters.status')}
                ><Badge tone={l.pending ? 'warning' : 'success'}
                  >{t(
                    l.pending ? 'admin.supporters.pending' : 'admin.supporter.list.confirmed'
                  )}</Badge
                ></td
              ></tr
            >
          {/each}{/snippet}
      </Table>
    {:else}
      <StatusLine tone="none" text={t('admin.supporter.lists.none')} />
    {/if}
  </Section>

  <Section id="supporter-campaigns" title={t('admin.supporter.campaigns')} locale={data.locale}>
    {#if data.participations.length}
      <Table
        id="supporter-campaigns-table"
        caption={t('admin.supporter.campaigns')}
        hideCaption
        stack
        card
        level
        columns={[
          { key: 'campaign', label: t('admin.supporter.campaign') },
          { key: 'kind', label: t('admin.supporter.campaign.kind') },
          { key: 'when', label: t('admin.supporter.campaign.when') },
          { key: 'state', label: t('admin.supporter.campaign.state') },
        ]}
      >
        {#snippet rows()}{#each data.participations as p (p.campaignId)}
            {@const at = when(p.confirmedAt)}
            <tr
              ><th scope="row" data-label={t('admin.supporter.campaign')}
                >{#if p.href && p.title}<a href={p.href}>{p.title}</a>{:else}{t(
                    `admin.campaign.kind.${p.kind}`
                  )}{/if}</th
              >
              <td data-label={t('admin.supporter.campaign.kind')}
                >{t(`admin.campaign.kind.${p.kind}`)}</td
              >
              <td data-label={t('admin.supporter.campaign.when')}
                ><time datetime={at.iso} title={at.full}>{at.text}</time></td
              >
              <td data-label={t('admin.supporter.campaign.state')}
                ><Badge tone={p.withdrawnAt ? 'warning' : 'success'}
                  >{t(
                    p.withdrawnAt
                      ? 'admin.supporter.campaign.withdrawn'
                      : 'admin.supporter.campaign.active'
                  )}</Badge
                ></td
              ></tr
            >
          {/each}{/snippet}
      </Table>
    {:else}
      <StatusLine tone="none" text={t('admin.supporter.campaigns.none')} />
    {/if}
  </Section>

  <Section id="supporter-access" title={t('admin.supporter.access')} locale={data.locale}>
    {#if data.access.length}
      <Table
        id="supporter-access-table"
        caption={t('admin.supporter.access')}
        hideCaption
        stack
        card
        level
        columns={[
          { key: 'tier', label: t('admin.supporter.access.tier') },
          { key: 'how', label: t('admin.supporter.access.how') },
          { key: 'until', label: t('admin.supporter.access.until') },
          { key: 'state', label: t('admin.supporter.access.state') },
        ]}
      >
        {#snippet rows()}{#each data.access as a (a.tierId)}
            <tr
              ><th scope="row" data-label={t('admin.supporter.access.tier')}>{a.name}</th>
              <td data-label={t('admin.supporter.access.how')}
                >{t(`admin.supporter.access.${a.grantKind}`)}</td
              >
              <td data-label={t('admin.supporter.access.until')}
                >{#if a.until}{@const end = when(a.until)}<time datetime={end.iso} title={end.full}
                    >{end.text}</time
                  >{:else}{t('admin.supporter.access.openEnded')}{/if}</td
              >
              <td data-label={t('admin.supporter.access.state')}
                ><Badge tone={a.standing ? 'success' : 'neutral'}
                  >{t(
                    a.standing
                      ? 'admin.supporter.access.standing'
                      : 'admin.supporter.access.expired'
                  )}</Badge
                ></td
              ></tr
            >
          {/each}{/snippet}
      </Table>
    {:else}
      <StatusLine tone="none" text={t('admin.supporter.access.none')} />
    {/if}
    {#if data.canGrant && !data.tiers.length}
      <p class="ui-hint">
        {t('admin.supporter.grant.noTiers')}
        <a href="{base}/access">{t('admin.supporter.grant.tiersLink')}</a>
      </p>
    {:else if data.canGrant}
      <Actions stack>
        <Dialog
          id="grant-access"
          title={t('admin.supporter.grant.title')}
          trigger={t('admin.supporter.grant')}
          variant="primary"
          locale={data.locale}
        >
          <form method="post" action="?/grant" class="ui-fields">
            <Select
              id="grant-tier"
              name="tierId"
              required
              label={t('admin.supporter.access.tier')}
              hint={t('admin.supporter.grant.replace')}
              locale={data.locale}
              options={data.tiers.map((tier) => ({ value: tier.id, label: tier.name }))}
            />
            <Select
              id="grant-kind"
              name="kind"
              required
              label={t('admin.supporter.access.how')}
              locale={data.locale}
              options={[
                { value: 'comp', label: t('admin.supporter.access.comp') },
                { value: 'gift', label: t('admin.supporter.access.gift') },
              ]}
            />
            <Field
              id="grant-until"
              name="until"
              type="datetime-local"
              label={t('admin.supporter.grant.until')}
              hint={zoneHint}
              locale={data.locale}
            />
            <Field
              id="grant-reason"
              name="reason"
              required
              maxlength={500}
              label={t('admin.supporter.grant.reason')}
              hint={t('admin.supporter.grant.reason.hint')}
              locale={data.locale}
            />
            <Actions><Button>{t('admin.supporter.grant')}</Button></Actions>
          </form>
        </Dialog>
        {#if standing.length}
          <Dialog
            id="revoke-access"
            title={t('admin.supporter.revoke')}
            trigger={t('admin.supporter.revoke')}
            locale={data.locale}
          >
            <form method="post" action="?/revoke" class="ui-fields">
              <Select
                id="revoke-tier"
                name="tierId"
                required
                label={t('admin.supporter.access.tier')}
                locale={data.locale}
                options={standing.map((a) => ({ value: a.tierId, label: a.name }))}
              />
              <Field
                id="revoke-reason"
                name="reason"
                required
                maxlength={500}
                label={t('admin.supporter.grant.reason')}
                hint={t('admin.supporter.grant.reason.hint')}
                locale={data.locale}
              />
              <Actions><Button>{t('admin.supporter.revoke')}</Button></Actions>
            </form>
          </Dialog>
        {/if}
      </Actions>
    {/if}
  </Section>

  <Section
    id="supporter-timeline"
    title={t('admin.supporter.timeline')}
    intro={t('admin.supporter.timeline.intro')}
    count={plural(t, 'admin.supporter.timeline.count', data.eventTotal)}
    locale={data.locale}
  >
    <Table
      id="supporter-timeline-table"
      caption={t('admin.supporter.timeline')}
      hideCaption
      stack
      card
      columns={[
        { key: 'what', label: t('admin.supporter.timeline.what') },
        { key: 'when', label: t('admin.supporter.timeline.when') },
      ]}
    >
      {#snippet rows()}{#each data.events as e (e.id)}
          {@const at = when(e.occurredAt)}
          <tr
            ><td data-label={t('admin.supporter.timeline.what')}
              >{eventSentence(t, e, data.names, data.locale)}</td
            >
            <td data-label={t('admin.supporter.timeline.when')}
              ><time datetime={at.iso} title={at.full}>{at.text}</time></td
            ></tr
          >
        {/each}{/snippet}
    </Table>
    {#if older > 0}<p class="supporter-older">
        {plural(t, 'admin.supporter.timeline.more', older)}
      </p>{/if}
  </Section>
</main>

<style>
  .supporter-older {
    margin-block: var(--space-2) 0;
  }
</style>
