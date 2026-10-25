<!-- Insert a block (TODO #11 B): the new block's fields, empty, as one native form; the type, the
     place and the revision travel as hidden fields. A refusal re-renders what was typed with the
     issues linked to their fields. -->
<script lang="ts">
  import BlockFields from '#lib/admin/BlockFields.svelte';
  import { BLOCK_DEFINITIONS } from '@mycel/core';
  import { fill, ui, type UiKey } from '../../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const values = $derived(form?.values ?? data.values);
  const typeName = $derived(t(`admin.block.type.${data.request.type}` as UiKey));
  const heading = $derived(fill(t('admin.block.new.title'), { type: typeName }));
  const where = $derived(
    data.request.anchor
      ? fill(t(`admin.block.new.${data.request.place}` as UiKey), { n: data.position })
      : t(`admin.block.place.${data.request.place}` as UiKey)
  );
  const fieldId = (name: string) => `new-${name.replaceAll('.', '-')}`;
  const fieldLabel = (name: string): string => {
    const parts = name.split('.').slice(1);
    const locale = data.docLocales.includes(parts.at(-1) ?? '') ? parts.pop() : null;
    const key = [...parts].reverse().find((p) => !/^\d+$/.test(p) && p !== 'mode');
    const label = key ? t(`admin.block.field.${key}` as UiKey) : typeName;
    return locale ? `${label} (${locale})` : label;
  };
</script>

<svelte:head>
  <title>{form ? `${t('error.prefix')} ` : ''}{heading} · {t('admin.title')}</title>
</svelte:head>

<main class="page admin">
  <h1>{heading}</h1>
  <p>{fill(t('admin.block.new.where'), { title: data.item.title, where })}</p>
  <p><a href="{base}/content/{data.item.id}">{t('admin.content.revisions.back')}</a></p>

  {#if form}
    <div class="error-summary" role="alert">
      <h2>{t('error.summary.title')}</h2>
      {#if form.conflict}
        <p>{fill(t('admin.block.new.conflict'), form.conflict)}</p>
      {:else}
        <p>{t(form.error as UiKey)}</p>
      {/if}
      <ul>
        {#each form.fieldIssues ?? [] as i (i.name + i.copy)}
          <li>
            {#if i.name}<a href="#{fieldId(i.name)}">{fieldLabel(i.name)}</a>:
            {/if}{t(i.copy as UiKey)}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <form method="post" class="card">
    <input type="hidden" name="type" value={data.request.type} />
    <input type="hidden" name="place" value={data.request.place} />
    <input type="hidden" name="anchor" value={data.request.anchor} />
    <input type="hidden" name="revision" value={values.revision ?? data.request.revision} />
    <BlockFields
      fields={BLOCK_DEFINITIONS[data.request.type].fields}
      {values}
      locales={data.docLocales}
      idPrefix="new"
      media={data.media}
      items={data.items}
      invalid={(form?.fieldIssues ?? []).map((x) => x.name)}
      locale={data.locale}
    />
    <div class="actions">
      <button type="submit">{t('admin.block.new.submit')}</button>
    </div>
  </form>
</main>
