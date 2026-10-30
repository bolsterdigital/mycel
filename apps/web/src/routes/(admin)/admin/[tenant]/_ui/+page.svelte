<!-- The component catalogue (brief #56 PR 1): each component once, with the longest real labels of
     the admin, so the UI gate in e2e/ui-gate.spec.ts measures what screens will show. Copy comes
     from the catalogs; the file names are sample data. The rail (#87) is the page's own sidebar,
     collapsed with its button; a field's hint behind its ⓘ is in the form section, a screen's
     sections under its menu item in the navigation section, and relative dates in the table. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    BlockCard,
    Button,
    ItemBar,
    StatusCard,
    Card,
    CardGrid,
    DashboardWidget,
    Checkbox,
    Choices,
    ConfirmAction,
    CopyField,
    Dialog,
    EmptyState,
    Field,
    Fieldset,
    FileDrop,
    Icon,
    KeyReveal,
    MetaList,
    NavGroup,
    Notice,
    PageHeader,
    Pagination,
    Panel,
    Select,
    SubNav,
    Table,
    Tabs,
  } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { fill, ui } from '../../../../../i18n/index.js';
  import { PATTERNS } from './patterns.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const here = $derived(`${base}/_ui`);
  const sample = '/_admin/ui-sample.svg';
  const size = (n: number) =>
    new Intl.NumberFormat(data.locale, {
      style: 'unit',
      unit: 'megabyte',
      maximumFractionDigits: 1,
    }).format(n / 1024 ** 2);
  const date = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      relative: data.dateFormat !== 'absolute',
    });
</script>

<svelte:head>
  <title>{t('admin.ui.catalogue.title')} · {data.tenant.name}</title>
</svelte:head>

<main class="page admin ui-catalogue">
  <PageHeader
    title={t('admin.ui.catalogue.title')}
    locale={data.locale}
    breadcrumb={[
      { label: t('admin.back'), href: '/admin' },
      { label: data.tenant.name, href: base },
      { label: t('admin.ui.catalogue.title') },
    ]}
    description={t('admin.ui.catalogue.intro')}
  >
    {#snippet actions()}
      <Button href="{base}/media">{t('admin.media.upload.title')}</Button>
    {/snippet}
  </PageHeader>

  <section aria-labelledby="ui-patterns">
    <h2 id="ui-patterns">{t('admin.ui.catalogue.patterns')}</h2>
    <p>{t('admin.ui.catalogue.patterns.intro')}</p>
    <ul class="ui-meta-links">
      {#each PATTERNS as pattern (pattern)}
        <li><a href="{here}/{pattern}">{t(`admin.ui.pattern.${pattern}`)}</a></li>
      {/each}
    </ul>
  </section>

  <section aria-labelledby="ui-buttons">
    <h2 id="ui-buttons">{t('admin.ui.catalogue.buttons')}</h2>
    <Actions>
      <Button>{t('admin.media.save')}</Button>
      <Button variant="secondary" href={sample}>{t('admin.media.download.original')}</Button>
      <Button variant="danger">{t('admin.media.delete')}</Button>
      <Button variant="link" href={base}>{t('admin.connections.cancel')}</Button>
    </Actions>
    <Actions stack>
      <Button>{fill(t('admin.content.publication.unschedule'), { locale: 'nl' })}</Button>
      <Button variant="secondary">{t('admin.status.close.cancel')}</Button>
    </Actions>
  </section>

  <section aria-labelledby="ui-notices">
    <h2 id="ui-notices">{t('admin.ui.catalogue.notices')}</h2>
    <Notice tone="success"><p>{t('admin.ui.catalogue.notice.success')}</p></Notice>
    <Notice tone="info"><p>{t('admin.ui.catalogue.notice.info')}</p></Notice>
    <Notice tone="warning"><p>{t('admin.ui.catalogue.notice.warning')}</p></Notice>
    <Notice tone="error" title={t('error.summary.title')}>
      <p>{t('admin.ui.catalogue.notice.error')}</p>
    </Notice>
  </section>

  <section aria-labelledby="ui-badges">
    <h2 id="ui-badges">{t('admin.ui.catalogue.badges')}</h2>
    <p>
      <Badge>{t('admin.content.status.draft')}</Badge>
      <Badge tone="info">{t('admin.content.status.scheduled')}</Badge>
      <Badge tone="success">{t('admin.content.status.published')}</Badge>
      <Badge tone="warning">{t('admin.media.access.restricted')}</Badge>
    </p>
  </section>

  <section aria-labelledby="ui-form">
    <h2 id="ui-form">{t('admin.ui.catalogue.form')}</h2>
    <form method="get" action={here}>
      <Fieldset legend={t('admin.ui.catalogue.form.group')}>
        <Field
          id="ui-title"
          name="title"
          label={t('admin.ui.catalogue.form.title')}
          locale={data.locale}
          hint={t('admin.ui.catalogue.form.titleHint')}
          error={t('admin.ui.catalogue.form.titleError')}
          required
        />
        <Select
          id="ui-kind"
          name="kind"
          label={t('admin.ui.catalogue.form.kind')}
          locale={data.locale}
          value="article"
          options={[
            { value: 'page', label: t('admin.ui.catalogue.form.page') },
            { value: 'article', label: t('admin.ui.catalogue.form.article') },
          ]}
        />
        <Choices
          id="ui-access"
          name="access"
          legend={t('admin.ui.catalogue.form.access')}
          locale={data.locale}
          selected={['public']}
          hint={t('admin.media.access.hint')}
          options={[
            { value: 'public', label: t('admin.media.access.public') },
            { value: 'restricted', label: t('admin.media.upload.restricted') },
          ]}
        />
        <FileDrop
          id="ui-file"
          name="file"
          label={t('admin.media.upload.file')}
          locale={data.locale}
        />
      </Fieldset>
      <Fieldset legend={t('admin.ui.catalogue.form.channels')} collapsed>
        <Choices
          id="ui-channels"
          name="channels"
          type="checkbox"
          legend={t('admin.ui.catalogue.form.channels')}
          locale={data.locale}
          options={[
            { value: 'newsletter', label: t('admin.ui.catalogue.form.newsletter') },
            { value: 'feed', label: t('admin.ui.catalogue.form.feed') },
          ]}
        />
        <Checkbox
          id="ui-noindex"
          name="noindex"
          label={t('admin.content.field.noindex')}
          hint={t('admin.ui.catalogue.form.noindexHint')}
        />
      </Fieldset>
      <Actions>
        <Button>{t('admin.media.save')}</Button>
        <Button variant="link" href={here}>{t('admin.connections.cancel')}</Button>
      </Actions>
    </form>
  </section>

  <section aria-labelledby="ui-panel">
    <h2 id="ui-panel">{t('admin.ui.catalogue.panel')}</h2>
    <Panel id="ui-panel-open" summary={t('admin.ui.catalogue.panel.summary')} open>
      <p>{t('admin.ui.catalogue.panel.body')}</p>
      <Actions stack>
        <Button variant="secondary">{t('admin.block.move.up')}</Button>
        <Button variant="secondary">{t('admin.block.move.down')}</Button>
        <Button variant="secondary" href={here}>{t('admin.block.remove')}</Button>
      </Actions>
    </Panel>
  </section>

  <section aria-labelledby="ui-block-card">
    <h2 id="ui-block-card">{t('admin.ui.catalogue.blockCard')}</h2>
    <BlockCard
      id="ui-block-card-faq"
      title="3. {t('admin.block.type.faq')}"
      text={t('admin.ui.catalogue.blockCard.text')}
      entries={[t('admin.ui.catalogue.blockCard.q1'), t('admin.ui.catalogue.blockCard.q2')]}
      empty={t('admin.block.emptySummary')}
      open
    >
      {#snippet actions()}
        <Button variant="link">{t('admin.block.move.up')}</Button>
        <Button variant="link">{t('admin.block.move.down')}</Button>
        <Button variant="link">{t('admin.block.duplicate')}</Button>
        <ConfirmAction
          variant="link"
          label={t('admin.block.remove.short')}
          question={fill(t('admin.block.remove.ask'), { n: 3 })}
          confirm={t('admin.block.remove.confirm')}
        />
      {/snippet}
      <p>{t('admin.ui.catalogue.panel.body')}</p>
    </BlockCard>
    <details class="ui-block-insert">
      <summary><Icon name="plus" />{t('admin.block.insert.fold')}</summary>
    </details>
    <BlockCard
      id="ui-block-card-empty"
      title="4. {t('admin.block.type.heading')}"
      text=""
      empty={t('admin.block.emptySummary')}
    >
      <p>{t('admin.ui.catalogue.panel.body')}</p>
    </BlockCard>
  </section>

  <section aria-labelledby="ui-table">
    <h2 id="ui-table">{t('admin.ui.catalogue.table')}</h2>
    <Table
      id="ui-files"
      caption={t('admin.ui.catalogue.table.caption')}
      columns={[
        { key: 'name', label: t('admin.ui.catalogue.table.name'), sortable: true },
        { key: 'changed', label: t('admin.ui.catalogue.table.changed'), sortable: true },
        { key: 'size', label: t('admin.media.size'), numeric: true },
      ]}
      sort={data.sort}
      sortHref={(key, dir) => `${here}?sort=${key}&dir=${dir}#ui-table`}
    >
      {#snippet rows()}
        {#each data.rows as row (row.name)}
          {@const changed = date(row.changed)}
          <tr>
            <td>{row.name}</td>
            <td><time datetime={changed.iso} title={changed.full}>{changed.text}</time></td>
            <td class="numeric">{size(row.size)}</td>
          </tr>
        {/each}
      {/snippet}
    </Table>
    <Pagination
      locale={data.locale}
      previous="{here}?page=1#ui-table"
      next="{here}?page=3#ui-table"
      position={fill(t('admin.usage.of'), { used: 2, max: 5 })}
    />
  </section>

  <section aria-labelledby="ui-cards">
    <h2 id="ui-cards">{t('admin.ui.catalogue.cards')}</h2>
    <CardGrid items={data.rows} key={(row) => row.name}>
      {#snippet card(row)}
        <Card title={row.name} href="#ui-cards">
          {#snippet media()}<img src={sample} alt="" width="1200" height="900" />{/snippet}
          <p class="muted">{size(row.size)} · {date(row.changed)}</p>
          {#snippet footer()}<Badge tone="success">{t('admin.media.access.public')}</Badge
            >{/snippet}
        </Card>
      {/snippet}
    </CardGrid>
    <EmptyState title={t('admin.ui.catalogue.empty.title')} level={3}>
      <p>{t('admin.ui.catalogue.empty.body')}</p>
      {#snippet action()}
        <Button href="{base}/content/new">{t('admin.ui.catalogue.empty.action')}</Button>
      {/snippet}
    </EmptyState>
  </section>

  <section aria-labelledby="ui-meta">
    <h2 id="ui-meta">{t('admin.ui.catalogue.meta')}</h2>
    <MetaList
      items={[
        { term: t('admin.ui.catalogue.table.name'), value: data.rows[0]?.name ?? '' },
        { term: t('admin.media.size'), value: size(data.rows[0]?.size ?? 0) },
        { term: t('admin.media.access'), value: t('admin.media.access.public') },
        {
          term: t('admin.media.usage'),
          value: t('admin.media.usage.one'),
          href: `${base}/content`,
        },
      ]}
    />
  </section>

  <section aria-labelledby="ui-subnav">
    <h2 id="ui-subnav">{t('admin.ui.catalogue.subnav')}</h2>
    <SubNav
      label={t('admin.ui.catalogue.subnav')}
      items={[
        { href: `${here}#ui-subnav`, label: t('admin.ui.catalogue.subnav.general'), current: true },
        { href: `${here}?section=theme#ui-subnav`, label: t('admin.ui.catalogue.subnav.theme') },
        {
          href: `${here}?section=domains#ui-subnav`,
          label: t('admin.ui.catalogue.subnav.domains'),
        },
      ]}
    />
  </section>

  <section aria-labelledby="ui-dialog">
    <h2 id="ui-dialog">{t('admin.ui.catalogue.dialog')}</h2>
    <Dialog
      id="ui-lightbox"
      title={data.rows[0]?.name ?? ''}
      trigger={t('admin.ui.catalogue.dialog.open')}
      locale={data.locale}
      wide
    >
      <img src={sample} alt="" width="1200" height="900" />
      <p>{t('admin.ui.catalogue.dialog.body')}</p>
    </Dialog>
  </section>
  <section aria-labelledby="ui-confirm">
    <h2 id="ui-confirm">{t('admin.ui.catalogue.confirm')}</h2>
    <!-- A form without action posts nowhere but this page: the catalogue has no actions. -->
    <form class="ui-card-form">
      <Card title="newsletter_sync_production">
        <Actions>
          <ConfirmAction
            label={t('admin.keys.revoke')}
            question={t('admin.keys.revokeQuestion')}
            confirm={t('admin.keys.revokeConfirm')}
            name="newsletter_sync_production"
          />
        </Actions>
      </Card>
    </form>
    <KeyReveal
      id="ui-reveal"
      title="{t('admin.keys.token.title')}: newsletter_sync_production"
      value="mycel_3q2Vh8y1Jt0WkXc5ZpQe7RrB9nLmA4sDfG6hJkLzXcV"
      locale={data.locale}
    >
      <p>{t('admin.keys.token.body')}</p>
    </KeyReveal>
    <CopyField
      id="ui-copy-field"
      label="{t('admin.domains.dns.txt')}: {t('admin.domains.dns.value')}"
      value="Xk3vQ9pL2mN7rT1wY5zA8bC4dE6fG0hJ-sU2iO3kP9q"
      locale={data.locale}
    />
  </section>
  <section aria-labelledby="ui-navigation">
    <h2 id="ui-navigation">{t('admin.ui.catalogue.navigation')}</h2>
    <nav aria-label={t('admin.ui.catalogue.navigation')}>
      <NavGroup
        id="ui-nav-content"
        label={t('admin.nav.group.content')}
        items={[
          {
            href: `${here}#ui-navigation`,
            label: t('admin.content.filter.page'),
            icon: 'file-text',
          },
          {
            href: `${base}/content?type=article`,
            label: t('admin.content.filter.article'),
            icon: 'newspaper',
          },
        ]}
      />
      <NavGroup
        id="ui-nav-manage"
        label={t('admin.nav.group.manage')}
        items={[
          {
            href: `${here}#ui-navigation`,
            label: t('admin.nav.settings'),
            icon: 'settings',
            current: true,
            children: [
              {
                href: `${here}#ui-navigation`,
                label: t('admin.ui.pattern.settings.general'),
                current: true,
              },
              { href: `${base}/site`, label: t('admin.ui.pattern.settings.contact') },
            ],
          },
          { href: `${base}/connections`, label: t('admin.nav.connections'), icon: 'plug' },
          { href: `${base}/assist`, label: t('admin.nav.assist'), icon: 'sparkles' },
        ]}
      />
    </nav>
  </section>

  <section aria-labelledby="ui-tabs">
    <h2 id="ui-tabs">{t('admin.ui.catalogue.tabs')}</h2>
    <p>{t('admin.ui.catalogue.tabs.intro')}</p>
    {#snippet tabContent()}<p>{t('admin.ui.catalogue.form.titleHint')}</p>{/snippet}
    {#snippet tabFindability()}<p>{t('admin.ui.catalogue.form.noindexHint')}</p>{/snippet}
    {#snippet tabSettings()}<p>{t('admin.ui.catalogue.panel.body')}</p>{/snippet}
    <Tabs
      id="ui-tabs-sample"
      label={t('admin.ui.catalogue.tabs')}
      level={3}
      tabs={[
        { id: 'content', label: t('admin.ui.catalogue.tabs.content'), content: tabContent },
        {
          id: 'findability',
          label: t('admin.ui.catalogue.tabs.findability'),
          content: tabFindability,
        },
        { id: 'settings', label: t('admin.ui.catalogue.tabs.settings'), content: tabSettings },
      ]}
    />
  </section>

  <section aria-labelledby="ui-item-bar">
    <h2 id="ui-item-bar">{t('admin.ui.catalogue.itemBar')}</h2>
    <p>{t('admin.ui.catalogue.itemBar.intro')}</p>
    <ItemBar
      back={{ href: '#ui-item-bar', label: t('admin.content.filter.page') }}
      title={fill(t('admin.content.edit.title'), { type: t('admin.content.type.page') })}
      state={t('admin.content.state.changed')}
      stateHref="#ui-status-card"
      tone="warning"
      level={3}
    >
      {#snippet actions()}
        <Button variant="secondary" type="button">{t('admin.content.edit.previewShort')}</Button>
        <Button type="button">{t('admin.content.edit.save')}</Button>
      {/snippet}
    </ItemBar>
  </section>

  <section aria-labelledby="ui-status-card">
    <h2 id="ui-status-card">{t('admin.ui.catalogue.statusCard')}</h2>
    <p>{t('admin.ui.catalogue.statusCard.intro')}</p>
    <StatusCard
      id="ui-status-card-sample"
      level={3}
      title={t('admin.content.edit.side')}
      state={t('admin.content.state.changed')}
      tone="warning"
    >
      {#snippet actions()}
        <Button type="button">{t('admin.content.action.publishChanges')}</Button>
        <Button variant="secondary" type="button">{t('admin.content.action.unpublish')}</Button>
      {/snippet}
      {#snippet more()}
        <details class="ui-fold">
          <summary>{t('admin.content.action.scheduleFold')}</summary>
          <p>{t('admin.content.publication.zone')} Europe/Amsterdam</p>
        </details>
      {/snippet}
    </StatusCard>
  </section>

  <section aria-labelledby="ui-widgets">
    <h2 id="ui-widgets">{t('admin.ui.catalogue.widgets')}</h2>
    <div class="ui-dashboard">
      <DashboardWidget
        id="ui-widget-waiting"
        level={3}
        title={t('admin.dashboard.waiting')}
        locale={data.locale}
      />
      <DashboardWidget
        id="ui-widget-usage"
        level={3}
        title={t('admin.dashboard.usage')}
        locale={data.locale}
      >
        <MetaList
          items={[
            { term: t('admin.ui.catalogue.table.name'), value: 'campaign-poster.jpg' },
            {
              term: t('admin.ui.catalogue.table.changed'),
              value: date('2026-10-28T09:00:00Z').text,
            },
          ]}
        />
      </DashboardWidget>
    </div>
  </section>
</main>
