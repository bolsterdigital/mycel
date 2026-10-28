<!-- A new page or article (TODO #11 A1, brief #56 § C2) on the form pattern: the type, the slug,
     the languages and a title per language, optionally a pattern to start from. One native form;
     a failed post comes back with what was typed. -->
<script lang="ts">
  import { Choices, Field, Fieldset, FormPage, Notice } from '#lib/admin/ui/index.js';
  import { ui, type UiKey } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const values = $derived(form?.values ?? null);
  const v = (k: string): string => {
    const x = values?.[k];
    return typeof x === 'string' ? x : '';
  };
  const type = $derived(v('type') || data.type);
  const locales = $derived(
    values ? ((values.locales as string[] | undefined) ?? []) : data.tenant.locales
  );
  const name = (p: { name: Partial<Record<string, string>> }) =>
    p.name[data.locale] ?? p.name[data.tenant.defaultLocale] ?? Object.values(p.name)[0] ?? '';
</script>

<svelte:head>
  <title
    >{form ? `${t('error.prefix')} ` : ''}{t('admin.content.new')} · {data.tenant.name} · {t(
      'admin.title'
    )}</title
  >
</svelte:head>

<FormPage
  title={t('admin.content.new')}
  locale={data.locale}
  breadcrumb={[
    { label: data.tenant.name, href: base },
    { label: t('admin.content.title'), href: `${base}/content?type=${type}` },
    { label: t('admin.content.new') },
  ]}
  submit={t('admin.content.new.submit')}
  cancel={{ href: `${base}/content?type=${type}`, label: t('admin.ui.cancel') }}
>
  {#snippet notices()}
    {#if form}
      <Notice tone="error" title={t('error.summary.title')}><p>{t(form.error as UiKey)}</p></Notice>
    {/if}
  {/snippet}

  <Choices
    id="type"
    name="type"
    legend={t('admin.content.type.legend')}
    locale={data.locale}
    selected={[type]}
    options={(['page', 'article'] as const).map((o) => ({
      value: o,
      label: t(`admin.content.type.${o}`),
    }))}
  />
  <Field
    id="slug"
    name="slug"
    label={t('admin.content.slug')}
    locale={data.locale}
    hint={t('admin.content.slug.hint')}
    required
    maxlength={63}
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    value={v('slug')}
  />
  <Choices
    id="locale"
    name="locales"
    type="checkbox"
    legend={t('admin.content.new.locales')}
    locale={data.locale}
    selected={locales}
    options={data.tenant.locales.map((l) => ({ value: l, label: l }))}
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
  {#if data.patterns.length}
    <Field id="pattern" label={t('admin.content.new.pattern')} locale={data.locale}>
      {#snippet control(attributes)}
        <select name="patternId" {...attributes}>
          <option value="">{t('admin.content.new.noPattern')}</option>
          {#each ['page', 'article'] as const as group (group)}
            {#if data.patterns.some((p) => p.type === group)}
              <optgroup label={t(`admin.content.type.${group}`)}>
                {#each data.patterns.filter((p) => p.type === group) as p (p.id)}
                  <option value={p.id} selected={v('patternId') === p.id}>{name(p)}</option>
                {/each}
              </optgroup>
            {/if}
          {/each}
        </select>
      {/snippet}
    </Field>
  {/if}
</FormPage>
