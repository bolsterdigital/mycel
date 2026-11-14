<!-- The form of one menu item. A link: where it leads (the target picker of the edit screen: a
     select of pages and articles, the home and search pages, or an address; with JavaScript one
     search field) and an optional menu text of its own in the content locale, which when left
     empty follows the page's published title. A group: only its text. Native controls; the picker
     is an enhancement. -->
<script lang="ts">
  import TargetPicker from '#lib/admin/block-fields/TargetPicker.svelte';
  import { Field, FormPage, Notice, Select } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const tenant = $derived(`/admin/${data.tenant.slug}`);
  const back = $derived(`${tenant}/navigation/${data.menu.id}`);
  const title = $derived(
    t(
      data.nodeId
        ? data.kind === 'group'
          ? 'admin.navigation.editGroup'
          : 'admin.navigation.editLink'
        : data.kind === 'group'
          ? 'admin.navigation.addGroup'
          : 'admin.navigation.addLink'
    )
  );
  const value = (key: 'label' | 'target' | 'url') => form?.values?.[key] ?? data.values[key];
  const refused = $derived(
    form?.error === 'admin.navigation.error.address' ||
      form?.error === 'admin.navigation.error.targetRequired' ||
      form?.error === 'admin.navigation.error.targetGone'
  );
  const labelMissing = $derived(form?.error === 'admin.navigation.error.labelRequired');
  const textLabel = $derived(
    data.tenant.locales.length > 1
      ? fill(t('admin.navigation.field.label.in'), { locale: data.contentLocale })
      : t('admin.navigation.field.label')
  );
</script>

<svelte:head>
  <title>{title} · {data.menu.name} · {data.tenant.name}</title>
</svelte:head>

<FormPage
  {title}
  locale={data.locale}
  breadcrumb={[
    { label: data.tenant.name, href: tenant },
    { label: t('admin.navigation.title'), href: `${tenant}/navigation` },
    { label: data.menu.name, href: back },
    { label: title },
  ]}
  description={data.kind === 'group' ? t('admin.navigation.group.intro') : undefined}
  submit={t('admin.navigation.save')}
  cancel={{ href: back, label: data.menu.name }}
>
  {#snippet notices()}
    {#if form?.error}<Notice tone="error">{t(form.error)}</Notice>{/if}
  {/snippet}
  <input type="hidden" name="baseRevisionId" value={data.baseRevisionId ?? ''} />
  <input type="hidden" name="kind" value={data.kind} />
  {#if data.kind === 'link'}
    <TargetPicker
      id="item-target"
      choices="{tenant}/content/choices?locale={encodeURIComponent(data.contentLocale)}"
      locale={data.locale}
      {refused}
    >
      <Select
        id="item-target"
        name="target"
        label={t('admin.block.field.target')}
        locale={data.locale}
        invalid={refused}
        value={value('target')}
        options={[
          { value: '', label: t('admin.block.none') },
          { value: 'home', label: t('admin.navigation.system.home') },
          { value: 'search', label: t('admin.navigation.system.search') },
          { value: 'url', label: t('admin.block.target.url') },
          ...data.items.map((i) => ({ value: i.id, label: i.label })),
        ]}
      />
      <Field
        id="item-url"
        name="url"
        label={t('admin.block.field.url')}
        hint={t('admin.navigation.field.url.hint')}
        hintInline
        locale={data.locale}
        invalid={refused}
        maxlength={2000}
        value={value('url')}
      />
    </TargetPicker>
  {/if}
  <Field
    id="item-label"
    name="label"
    label={textLabel}
    hint={data.kind === 'group'
      ? t('admin.navigation.field.label.groupHint')
      : data.inherited
        ? fill(t('admin.navigation.field.label.inherits'), { title: data.inherited })
        : t('admin.navigation.field.label.hint')}
    hintInline
    locale={data.locale}
    required={data.kind === 'group'}
    invalid={labelMissing}
    maxlength={120}
    value={value('label')}
  />
</FormPage>
