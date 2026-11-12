<!-- A new petition or signup on the form pattern: the kind first, because it decides the
     form that comes with it, then a title per language, the languages, an optional address and an
     optional goal. One native form; a failed post comes back with what was typed. -->
<script lang="ts">
  import { Choices, Field, Fieldset, FormPage, Notice } from '#lib/admin/ui/index.js';
  import { ui, refusalCopy } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const values = $derived(form?.values ?? null);
  const v = (k: string): string => {
    const x = values?.[k];
    return typeof x === 'string' ? x : '';
  };
  const heading = $derived(t('admin.campaign.new'));
  const locales = $derived(
    values ? ((values.locales as string[] | undefined) ?? []) : data.tenant.locales
  );
</script>

<svelte:head>
  <title
    >{form ? `${t('error.prefix')} ` : ''}{heading} · {data.tenant.name} · {t('admin.title')}</title
  >
</svelte:head>

<FormPage
  title={heading}
  locale={data.locale}
  breadcrumb={[
    { label: data.tenant.name, href: base },
    { label: t('admin.campaign.title'), href: `${base}/campaigns` },
    { label: heading },
  ]}
  description={t('admin.campaign.new.intro')}
  submit={t('admin.campaign.new.submit')}
  cancel={{ href: `${base}/campaigns`, label: t('admin.ui.cancel') }}
>
  {#snippet notices()}
    {#if form}
      <Notice tone="error" title={t('error.summary.title')}><p>{refusalCopy(t, form)}</p></Notice>
    {/if}
  {/snippet}

  <Choices
    id="kind"
    name="kind"
    type="radio"
    legend={t('admin.campaign.column.kind')}
    locale={data.locale}
    hint={t('admin.campaign.kind.hint')}
    selected={[v('kind') || data.kind]}
    options={[
      { value: 'petition', label: t('admin.campaign.kind.petition') },
      { value: 'signup', label: t('admin.campaign.kind.signup') },
    ]}
  />
  <Fieldset legend={t('admin.content.field.title')}>
    {#each data.tenant.locales as l (l)}
      <Field
        id="title-{l}"
        name="title.{l}"
        label="{t('admin.content.field.title')} ({l})"
        locale={data.locale}
        maxlength={200}
        lang={l}
        required={l === data.tenant.defaultLocale}
        value={v(`title.${l}`)}
      />
    {/each}
  </Fieldset>
  <Choices
    id="locale"
    name="locales"
    type="checkbox"
    legend={t('admin.content.new.locales')}
    locale={data.locale}
    selected={locales}
    options={data.tenant.locales.map((l) => ({ value: l, label: l }))}
  />
  <Field
    id="slug"
    name="slug"
    label={t('admin.content.slug')}
    locale={data.locale}
    hint={t('admin.content.slug.hint')}
    maxlength={63}
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    value={v('slug')}
  />
  <Field
    id="target"
    name="target"
    type="number"
    min={1}
    step={1}
    inputmode="numeric"
    label={t('admin.campaign.field.target')}
    hint={t('admin.campaign.field.target.hint')}
    locale={data.locale}
    value={v('target')}
  />
</FormPage>
