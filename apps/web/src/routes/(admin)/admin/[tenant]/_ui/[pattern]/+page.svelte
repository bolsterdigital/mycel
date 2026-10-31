<!-- A page pattern of the catalogue (brief #56 § B) filled with the copy of a real screen, so the
     UI gate in e2e/ui-gate.spec.ts measures each pattern as screens will use it. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Card,
    CardGrid,
    Checkbox,
    Choices,
    DetailPage,
    Dialog,
    EditPage,
    Field,
    Fieldset,
    FormPage,
    MetaList,
    Notice,
    OverviewPage,
    BlockCard,
    BlockSummary,
    PageHeader,
    SettingsPage,
    SettingsSection,
    SystemState,
    Table,
  } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const catalogue = $derived(`${base}/_ui`);
  const here = $derived(`${catalogue}/${data.pattern}`);
  const sample = '/_admin/ui-sample.svg';
  const title = $derived(t(`admin.ui.pattern.${data.pattern}`));
  const breadcrumb = $derived([
    { label: data.tenant.name, href: base },
    { label: t('admin.ui.catalogue.title'), href: catalogue },
    { label: title },
  ]);
  const files = [
    'campaign-poster-final-version-2026.jpg',
    'annual-report.pdf',
    'volunteers-at-the-market.webp',
  ];
  const saved = $derived(form?.saved ?? '');
  const access = $derived([
    { value: 'public', label: t('admin.media.access.public') },
    { value: 'restricted', label: t('admin.media.access.restricted') },
  ]);
</script>

<svelte:head>
  <title>{title} · {t('admin.ui.catalogue.title')} · {data.tenant.name}</title>
</svelte:head>

{#if data.pattern === 'overview'}
  <OverviewPage
    {title}
    locale={data.locale}
    {breadcrumb}
    description={t('admin.ui.catalogue.notice.warning')}
    listTitle={t('admin.media.library')}
    views={{
      label: t('admin.media.view.label'),
      items: [
        { href: here, label: t('admin.media.view.grid'), current: data.view === 'grid' },
        {
          href: `${here}?view=list`,
          label: t('admin.media.view.list'),
          current: data.view === 'list',
        },
      ],
    }}
    paging={{ previous: `${here}?page=1`, next: `${here}?page=3` }}
  >
    {#snippet actions()}
      <Button href="{base}/media">{t('admin.media.upload.title')}</Button>
    {/snippet}
    {#snippet filters()}
      <form method="get" action={here}>
        <Field
          id="ui-filter"
          name="q"
          type="search"
          label={t('admin.ui.pattern.filter')}
          locale={data.locale}
        />
        <Actions><Button variant="secondary">{t('admin.ui.pattern.filter.submit')}</Button></Actions
        >
      </form>
    {/snippet}
    {#if data.view === 'list'}
      <Table
        id="ui-pattern-table"
        caption={t('admin.media.library')}
        columns={[
          { key: 'name', label: t('admin.media.filename') },
          { key: 'access', label: t('admin.media.access') },
        ]}
      >
        {#snippet rows()}
          {#each files as file (file)}
            <tr>
              <th scope="row"><a href="{catalogue}/detail">{file}</a></th>
              <td>{t('admin.media.access.public')}</td>
            </tr>
          {/each}
        {/snippet}
      </Table>
    {:else}
      <CardGrid items={files} key={(file) => file} label={t('admin.media.library')}>
        {#snippet card(file)}
          <Card title={file} href="{catalogue}/detail">
            {#snippet media()}<img src={sample} alt="" width="1200" height="900" />{/snippet}
            <p class="muted">1200 × 900 px</p>
            {#snippet footer()}<Badge>{t('admin.media.access.public')}</Badge>{/snippet}
          </Card>
        {/snippet}
      </CardGrid>
    {/if}
  </OverviewPage>
{:else if data.pattern === 'detail'}
  <DetailPage
    title={files[0]!}
    locale={data.locale}
    {breadcrumb}
    previewLabel={t('admin.media.preview')}
  >
    {#snippet preview()}
      <img src={sample} alt="" width="1200" height="900" />
      <Dialog
        id="ui-detail-lightbox"
        title={files[0]!}
        trigger={t('admin.media.lightbox')}
        locale={data.locale}
        wide
      >
        <img src={sample} alt="" width="1200" height="900" />
      </Dialog>
    {/snippet}
    {#snippet meta()}
      <MetaList
        items={[
          { term: t('admin.media.filename'), value: files[0]! },
          { term: t('admin.media.dimensions'), value: '1200 × 900 px' },
          { term: t('admin.media.access'), value: t('admin.media.access.public') },
          {
            term: t('admin.media.usedIn'),
            value: '',
            links: [
              { label: t('admin.ui.catalogue.form.page'), href: `${base}/content` },
              { label: t('admin.ui.catalogue.form.article'), href: `${base}/content?type=article` },
            ],
          },
        ]}
      />
    {/snippet}
    <form method="post" action="?/save">
      <input type="hidden" name="section" value="detail" />
      <Fieldset legend={t('admin.media.field.work')}>
        <Field
          id="ui-work-title"
          name="title"
          label={t('admin.media.field.workTitle')}
          locale={data.locale}
        />
        <Field
          id="ui-work-maker"
          name="maker"
          label={t('admin.media.field.workMaker')}
          locale={data.locale}
        />
      </Fieldset>
      <Actions><Button>{t('admin.media.save')}</Button></Actions>
    </form>
    {#snippet footer()}
      <Actions>
        <Button variant="secondary" href={sample}>{t('admin.media.download.original')}</Button>
        <Button variant="danger" type="button">{t('admin.media.delete')}</Button>
      </Actions>
    {/snippet}
  </DetailPage>
{:else if data.pattern === 'edit'}
  <EditPage
    {title}
    locale={data.locale}
    {breadcrumb}
    description={t('admin.ui.catalogue.form.titleHint')}
    asideLabel={t('admin.content.edit.side')}
  >
    {#snippet actions()}
      <Button variant="secondary" href={catalogue}>{t('admin.content.revisions')}</Button>
      <Button variant="secondary" href={catalogue} target="_blank"
        >{t('admin.content.revisions.preview')}</Button
      >
    {/snippet}
    {#snippet notices()}
      {#if saved === 'edit'}
        <Notice tone="success"><p>{t('admin.content.done.saved')}</p></Notice>
      {/if}
    {/snippet}
    <form method="post" action="?/save" aria-labelledby="ui-edit-fields">
      <h2 id="ui-edit-fields">{t('admin.content.edit.fields')}</h2>
      <input type="hidden" name="section" value="edit" />
      <Fieldset legend={t('admin.content.edit.heading')}>
        <Field
          id="ui-edit-title"
          name="title"
          label="{t('admin.content.field.title')} (nl)"
          locale={data.locale}
          required
        />
        <Field
          id="ui-edit-lead"
          name="lead"
          label="{t('admin.content.field.lead')} (nl)"
          locale={data.locale}
        />
      </Fieldset>
      <Fieldset legend={t('admin.content.edit.seo')} collapsed>
        <Field
          id="ui-edit-seo"
          name="seoTitle"
          label="{t('admin.content.field.seoTitle')} (nl)"
          locale={data.locale}
        />
        <Checkbox id="ui-edit-noindex" name="noindex" label={t('admin.content.field.noindex')} />
      </Fieldset>
      <Actions><Button>{t('admin.content.edit.save')}</Button></Actions>
    </form>
    <section aria-labelledby="ui-edit-blocks">
      <h2 id="ui-edit-blocks">{t('admin.block.title')}</h2>
      <BlockCard
        id="ui-edit-block"
        title="1. {t('admin.block.type.faq')}"
        labels={{
          edit: t('admin.block.card.edit'),
          done: t('admin.block.card.done'),
          more: t('admin.block.card.more'),
        }}
        open
      >
        {#snippet rest()}
          <BlockSummary
            text={t('admin.ui.catalogue.blockCard.text')}
            entries={[t('admin.ui.catalogue.blockCard.q1')]}
            empty={t('admin.block.emptySummary')}
          />
        {/snippet}
        {#snippet actions()}
          <Button variant="secondary" href={here}>{t('admin.block.move.down')}</Button>
          <Button variant="secondary" href={here}>{t('admin.block.duplicate')}</Button>
        {/snippet}
        <p>{t('admin.ui.catalogue.panel.body')}</p>
      </BlockCard>
    </section>
    {#snippet aside()}
      <section aria-labelledby="ui-edit-state">
        <h2 id="ui-edit-state">{t('admin.content.state')}</h2>
        <MetaList
          items={[
            { term: t('admin.content.type.legend'), value: t('admin.content.type.article') },
            { term: t('admin.content.slug'), value: '/campaign-poster-final-version-2026' },
          ]}
        />
      </section>
      <section aria-labelledby="ui-edit-publication">
        <h2 id="ui-edit-publication">{t('admin.content.publication.title')}</h2>
        <Card
          title="{fill(t('admin.content.publication.locale'), { locale: 'nl' })}: {t(
            'admin.content.status.published'
          )}, {t('admin.content.status.changes')}"
        >
          <p>{t('admin.content.publication.ready')}</p>
          <Actions stack>
            <Button href={here}
              >{fill(t('admin.content.publication.publish'), { locale: 'nl' })}</Button
            >
            <Button variant="secondary" href={here}
              >{fill(t('admin.content.publication.repin'), { locale: 'nl' })}</Button
            >
          </Actions>
        </Card>
      </section>
    {/snippet}
  </EditPage>
{:else if data.pattern === 'settings'}
  <SettingsPage
    {title}
    locale={data.locale}
    {breadcrumb}
    nav={{
      label: t('admin.ui.catalogue.subnav'),
      items: [
        { href: here, label: t('admin.ui.catalogue.subnav.general'), current: true },
        { href: `${here}?section=theme`, label: t('admin.ui.catalogue.subnav.theme') },
        { href: `${here}?section=domains`, label: t('admin.ui.catalogue.subnav.domains') },
      ],
    }}
  >
    <SettingsSection
      id="ui-general"
      title={t('admin.ui.pattern.settings.general')}
      description={t('admin.ui.pattern.settings.generalHint')}
      action="?/save"
      submit={t('admin.media.save')}
      saved={saved === 'general' ? t('admin.ui.pattern.settings.saved') : undefined}
    >
      <input type="hidden" name="section" value="general" />
      <Field
        id="ui-site-name"
        name="name"
        label={t('admin.ui.catalogue.form.title')}
        locale={data.locale}
        required
        value={data.tenant.name}
      />
    </SettingsSection>
    <SettingsSection
      id="ui-contact"
      title={t('admin.ui.pattern.settings.contact')}
      action="?/save"
      submit={t('admin.media.save')}
      saved={saved === 'contact' ? t('admin.ui.pattern.settings.saved') : undefined}
    >
      <input type="hidden" name="section" value="contact" />
      <Field
        id="ui-contact-email"
        name="email"
        type="email"
        label={t('admin.ui.pattern.contact.email')}
        locale={data.locale}
      />
    </SettingsSection>
  </SettingsPage>
{:else if data.pattern === 'form'}
  <FormPage
    {title}
    locale={data.locale}
    {breadcrumb}
    description={t('admin.ui.catalogue.form.titleHint')}
    action="?/save"
    submit={t('admin.media.save')}
    cancel={{ href: catalogue, label: t('admin.connections.cancel') }}
  >
    {#snippet notices()}
      {#if saved === 'form'}
        <Notice tone="success"><p>{t('admin.ui.catalogue.notice.success')}</p></Notice>
      {/if}
    {/snippet}
    <input type="hidden" name="section" value="form" />
    <Fieldset legend={t('admin.ui.catalogue.form.group')}>
      <Field
        id="ui-form-title"
        name="title"
        label={t('admin.ui.catalogue.form.title')}
        locale={data.locale}
        hint={t('admin.ui.catalogue.form.titleHint')}
        required
      />
      <Choices
        id="ui-form-access"
        name="access"
        legend={t('admin.ui.catalogue.form.access')}
        locale={data.locale}
        selected={['public']}
        options={access}
      />
    </Fieldset>
  </FormPage>
{:else}
  <main class="page admin ui-states">
    <PageHeader {title} locale={data.locale} {breadcrumb} />
    <div class="ui-settings">
      <SystemState kind="loading" title={t('admin.ui.pattern.states.loading')}>
        <p>{t('admin.ui.pattern.states.loadingBody')}</p>
      </SystemState>
      <SystemState kind="empty" title={t('admin.ui.catalogue.empty.title')}>
        <p>{t('admin.ui.catalogue.empty.body')}</p>
        {#snippet action()}
          <Button href="{base}/content/new">{t('admin.ui.catalogue.empty.action')}</Button>
        {/snippet}
      </SystemState>
      <SystemState kind="error" title={t('admin.error.title')}>
        <p>{t('admin.ui.catalogue.notice.error')}</p>
      </SystemState>
      <SystemState kind="forbidden" title={t('admin.forbidden.title')}>
        {#snippet action()}<Button variant="secondary" href="/admin">{t('admin.back')}</Button
          >{/snippet}
      </SystemState>
      <SystemState kind="signed-out" title={t('admin.ui.pattern.states.signedOut')}>
        <p>{t('admin.ui.pattern.states.signedOutBody')}</p>
        {#snippet action()}<Button href="/admin/login">{t('admin.login.again')}</Button>{/snippet}
      </SystemState>
    </div>
  </main>
{/if}
