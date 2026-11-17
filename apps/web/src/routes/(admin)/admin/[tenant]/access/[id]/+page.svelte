<!-- Slug and kind are asked once: core fixes them at create, so the edit form shows them as text. -->
<script lang="ts">
  import { page } from '$app/state';
  import { FormPage, Field, MetaList, Notice, Select } from '#lib/admin/ui/index.js';
  import { ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/access`);
  const value = (key: string, initial = '') => form?.values?.[key] ?? initial;
  const title = $derived(t(data.tier ? 'admin.tiers.edit' : 'admin.tiers.new'));
</script>

<svelte:head><title>{title} · {data.tenant.name}</title></svelte:head>
<FormPage
  {title}
  locale={data.locale}
  submit={t('admin.tiers.save')}
  cancel={{ href: base, label: t('admin.tiers.title') }}
>
  {#snippet notices()}{#if form?.error}<Notice tone="error">{t(form.error)}</Notice
      >{:else if page.url.searchParams.has('saved')}<Notice tone="success"
        >{t('admin.tiers.saved')}</Notice
      >{/if}{/snippet}
  <input type="hidden" name="contentLocale" value={value('contentLocale', data.contentLocale)} />
  <input
    type="hidden"
    name="baseUpdatedAt"
    value={value('baseUpdatedAt', data.tier?.updatedAt ?? '')}
  />
  <Field
    id="tier-name"
    name="name"
    required
    maxlength={200}
    label={t('admin.tiers.name')}
    hint={t('admin.tiers.name.hint')}
    locale={data.locale}
    value={value('name', data.tier?.name[data.contentLocale])}
  />
  <Field
    id="tier-description"
    label={t('admin.tiers.description')}
    hint={t('admin.tiers.description.hint')}
    locale={data.locale}
  >
    {#snippet control(attributes)}<textarea
        {...attributes}
        name="description"
        rows="3"
        maxlength="2000"
        >{value('description', data.tier?.description?.[data.contentLocale])}</textarea
      >{/snippet}
  </Field>
  {#if data.tier}
    <MetaList
      items={[
        { term: t('admin.tiers.slug'), value: data.tier.slug },
        { term: t('admin.tiers.kind'), value: t(`admin.tiers.kind.${data.tier.kind}`) },
      ]}
    />
  {:else}
    <Field
      id="tier-slug"
      name="slug"
      maxlength={63}
      pattern={'[a-z0-9][a-z0-9-]{0,62}'}
      autocapitalize="off"
      spellcheck={false}
      label={t('admin.tiers.slug')}
      hint={t('admin.tiers.slug.hint')}
      locale={data.locale}
      value={value('slug')}
    />
    <Select
      id="tier-kind"
      name="kind"
      label={t('admin.tiers.kind')}
      hint={t('admin.tiers.kind.hint')}
      locale={data.locale}
      value={value('kind', 'free')}
      options={[
        { value: 'free', label: t('admin.tiers.kind.free') },
        { value: 'paid', label: t('admin.tiers.kind.paid') },
      ]}
    />
  {/if}
  <Field
    id="tier-order"
    name="order"
    type="number"
    min={0}
    max={10000}
    required
    label={t('admin.tiers.order')}
    locale={data.locale}
    value={value('order', String(data.tier?.order ?? 0))}
  />
</FormPage>
