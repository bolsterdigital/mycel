<!-- One menu in the menu editor (brief site-navigation § 3). The items stand as the menu is built:
     an ordered list, sub-items inside their parent. Each shows the text visitors read in the
     content locale and where that text comes from, where it leads, and its steps: up, down, make
     it a sub-item, bring it back to the top level, edit, remove. Every step is a native submit of
     one form, so ordering and nesting work with a keyboard, one click and without JavaScript; a
     step that the node cannot take is not offered. `new` is the form that names a new menu.
     Rejected: disabled buttons for the steps a node cannot take (four dead controls per row to
     tab through). -->
<script lang="ts">
  import '#lib/admin/navigation/menu-list.css';
  import { page } from '$app/state';
  import {
    Actions,
    Badge,
    Button,
    ConfirmAction,
    EmptyState,
    Field,
    FormPage,
    Notice,
    PageHeader,
    Section,
  } from '#lib/admin/ui/index.js';
  import type { MenuRow } from '#lib/server/navigation/admin.js';
  import { fill, ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/navigation`);
  const title = $derived(data.menu?.name ?? t('admin.navigation.newMenu'));
  const crumbs = $derived([
    { label: data.tenant.name, href: `/admin/${data.tenant.slug}` },
    { label: t('admin.navigation.title'), href: base },
    { label: title },
  ]);
  const shown = (row: MenuRow) =>
    row.label ??
    (row.target?.kind === 'home' || row.target?.kind === 'search'
      ? t(`admin.navigation.system.${row.target.kind}`)
      : t('admin.navigation.noLabel'));
  const leads = (row: MenuRow) =>
    !row.target
      ? ''
      : row.target.kind === 'home' || row.target.kind === 'search'
        ? t(`admin.navigation.system.${row.target.kind}`)
        : row.target.text;
  const facts = (row: MenuRow) =>
    [
      row.source && t(`admin.navigation.source.${row.source}`),
      row.target && fill(t('admin.navigation.leadsTo'), { target: leads(row) }),
    ]
      .filter(Boolean)
      .join(' · ');
</script>

<svelte:head>
  <title>{title} · {t('admin.navigation.title')} · {data.tenant.name}</title>
</svelte:head>

{#snippet notices()}
  {#if form?.error}<Notice tone="error">{t(form.error)}</Notice
    >{:else if page.url.searchParams.has('merged')}<Notice tone="success"
      >{t('admin.navigation.merged')}</Notice
    >{:else if page.url.searchParams.has('saved')}<Notice tone="success"
      >{t('admin.navigation.saved')}</Notice
    >{/if}
{/snippet}

{#snippet item(row: MenuRow)}
  <div class="ui-menu-item">
    <p class="ui-menu-item-label">
      {shown(row)}
      {#if row.kind === 'group'}<Badge>{t('admin.navigation.kind.group')}</Badge>{/if}
      {#if row.state && row.state !== 'ok'}<Badge tone="warning"
          >{t(`admin.navigation.state.${row.state}`)}</Badge
        >{:else if !row.label && row.source !== 'system'}<Badge tone="warning"
          >{fill(t('admin.navigation.state.noLabel'), { locale: data.contentLocale })}</Badge
        >{/if}
    </p>
    <p class="ui-menu-item-facts">{facts(row)}</p>
    {#if data.canWrite}
      <Actions>
        {#each row.moves as move (move)}
          <Button
            variant="secondary"
            form="menu-steps"
            formaction="?/move"
            name="step"
            value="{row.id}|{move}"
            aria-label="{t(`admin.navigation.move.${move}`)}: {shown(row)}"
            >{t(`admin.navigation.move.${move}`)}</Button
          >
        {/each}
        <Button
          variant="link"
          href="{base}/{data.menu?.id}/items/{row.id}"
          aria-label="{t('admin.navigation.edit')}: {shown(row)}"
          >{t('admin.navigation.edit')}</Button
        >
        <ConfirmAction
          variant="link"
          label={t('admin.navigation.remove')}
          question={t(
            row.children.length
              ? 'admin.navigation.remove.questionSub'
              : 'admin.navigation.remove.question'
          )}
          confirm={t('admin.navigation.remove.confirm')}
          name={shown(row)}
          form="menu-steps"
          formaction="?/remove"
          field={{ name: 'nodeId', value: row.id }}
        />
      </Actions>
    {/if}
  </div>
{/snippet}

{#if !data.menu}
  <FormPage
    {title}
    locale={data.locale}
    breadcrumb={crumbs}
    description={t('admin.navigation.newMenu.intro')}
    action="?/create"
    submit={t('admin.navigation.newMenu.submit')}
    cancel={{ href: base, label: t('admin.navigation.title') }}
    {notices}
  >
    <input type="hidden" name="baseRevisionId" value={data.baseRevisionId ?? ''} />
    <Field
      id="menu-name"
      name="name"
      required
      maxlength={80}
      label={t('admin.navigation.field.name')}
      hint={t('admin.navigation.field.name.hint')}
      hintInline
      locale={data.locale}
      value={form?.values?.['name'] ?? ''}
    />
  </FormPage>
{:else}
  <main class="page admin ui-overview">
    <PageHeader
      {title}
      locale={data.locale}
      breadcrumb={crumbs}
      description={data.usedIn.length
        ? fill(t('admin.navigation.usedIn'), {
            places: data.usedIn.map((p) => t(`admin.navigation.placement.${p}`)).join(', '),
          })
        : t('admin.navigation.notPlaced.long')}
    >
      {#snippet actions()}
        {#if data.canWrite}
          <Button href="{base}/{data.menu?.id}/items/new">{t('admin.navigation.addLink')}</Button>
          <Button variant="secondary" href="{base}/{data.menu?.id}/items/new?kind=group"
            >{t('admin.navigation.addGroup')}</Button
          >
        {/if}
      {/snippet}
    </PageHeader>
    {@render notices()}
    <form id="menu-steps" method="post">
      <input type="hidden" name="baseRevisionId" value={data.baseRevisionId ?? ''} />
    </form>
    <Section
      id="menu-items"
      title={t('admin.navigation.items')}
      intro={fill(t('admin.navigation.items.intro'), { locale: data.contentLocale })}
      locale={data.locale}
    >
      {#if data.rows.length}
        <ol class="ui-menu-list">
          {#each data.rows as row (row.id)}
            <li>
              {@render item(row)}
              {#if row.children.length}
                <ol aria-label={fill(t('admin.navigation.subItemsOf'), { name: shown(row) })}>
                  {#each row.children as child (child.id)}
                    <li>{@render item(child)}</li>
                  {/each}
                </ol>
              {/if}
            </li>
          {/each}
        </ol>
      {:else}
        <EmptyState title={t('admin.navigation.items.empty')} level={3} icon="menu">
          <p>{t('admin.navigation.items.empty.body')}</p>
        </EmptyState>
      {/if}
    </Section>
    {#if data.canWrite}
      <Section id="menu-name-section" title={t('admin.navigation.field.name')} locale={data.locale}>
        <form method="post" action="?/rename">
          <input type="hidden" name="baseRevisionId" value={data.baseRevisionId ?? ''} />
          <div class="ui-fields">
            <Field
              id="menu-name"
              name="name"
              required
              maxlength={80}
              label={t('admin.navigation.field.name')}
              hint={t('admin.navigation.field.name.hint')}
              hintInline
              locale={data.locale}
              value={form?.values?.['name'] ?? data.menu.name}
            />
          </div>
          <Actions><Button variant="secondary">{t('admin.navigation.rename')}</Button></Actions>
        </form>
      </Section>
      <Section id="menu-delete" title={t('admin.navigation.delete')} locale={data.locale}>
        {#if data.usedIn.length}
          <p>{t('admin.navigation.delete.placed')}</p>
        {:else}
          <Actions>
            <ConfirmAction
              label={t('admin.navigation.delete')}
              question={t('admin.navigation.delete.question')}
              confirm={t('admin.navigation.delete.confirm')}
              name={data.menu.name}
              form="menu-steps"
              formaction="?/delete"
            />
          </Actions>
        {/if}
      </Section>
    {/if}
  </main>
{/if}
