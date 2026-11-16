<!-- A new page or article (TODO #11 A1, brief #56 § C2) on the form pattern. The editor starts at
     the title (editor trial 2026-10-28): a title per language, then an optional slug that core derives from the
     title when left empty, the languages and a pattern. An article also offers the standard long
     read, first and even when the site has no patterns of its own. The type comes from the menu
     item the editor came from. One native form; a failed post comes back with what was typed. -->
<script lang="ts">
  import { Choices, Field, Fieldset, FormPage, Notice } from '#lib/admin/ui/index.js';
  import PatternChoice, { offers } from '#lib/admin/patterns/PatternChoice.svelte';
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
  const type = $derived((v('type') || data.type) === 'article' ? 'article' : 'page');
  const heading = $derived(t(`admin.content.new.${type}`));
  const kind = $derived(
    t(type === 'page' ? 'admin.content.filter.page' : 'admin.content.filter.article')
  );
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
    { label: kind, href: `${base}/content?type=${type}` },
    { label: heading },
  ]}
  submit={t('admin.content.new.submit')}
  cancel={{ href: `${base}/content?type=${type}`, label: t('admin.ui.cancel') }}
>
  {#snippet notices()}
    {#if form}
      <Notice tone="error" title={t('error.summary.title')}><p>{refusalCopy(t, form)}</p></Notice>
    {/if}
  {/snippet}

  <input type="hidden" name="type" value={type} />
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
  <Choices
    id="locale"
    name="locales"
    type="checkbox"
    legend={t('admin.content.new.locales')}
    locale={data.locale}
    selected={locales}
    options={data.tenant.locales.map((l) => ({ value: l, label: l }))}
  />
  {#if offers(data.patterns)}
    <PatternChoice
      id="pattern"
      locale={data.locale}
      choices={data.patterns}
      selected={v('patternId')}
      optional
    />
  {/if}
</FormPage>
