<!-- A new page or article (TODO #11 A1). One native form; the title fields follow the site's
     locales, and a failed post comes back with what was typed. -->
<script lang="ts">
  import Header from '#lib/admin/Header.svelte';
  import { ui, type UiKey } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
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

<Header locale={data.locale} email={data.email} />
<main class="page admin">
  <h1>{t('admin.content.new')}</h1>
  <p><a href="/admin/{data.tenant.slug}/content">{t('admin.content.title')}</a></p>

  {#if form}
    <div class="error-summary" role="alert">
      <h2>{t('error.summary.title')}</h2>
      <p>{t(form.error as UiKey)}</p>
    </div>
  {/if}

  <form method="post" class="card">
    <fieldset>
      <legend>{t('admin.content.type.legend')}</legend>
      {#each ['page', 'article'] as const as option (option)}
        <div class="check">
          <input
            type="radio"
            id="type-{option}"
            name="type"
            value={option}
            checked={type === option}
          />
          <label for="type-{option}">{t(`admin.content.type.${option}` as UiKey)}</label>
        </div>
      {/each}
    </fieldset>
    <div class="field">
      <label for="slug">{t('admin.content.slug')}</label>
      <p class="muted" id="slug-hint">{t('admin.content.slug.hint')}</p>
      <input
        id="slug"
        name="slug"
        type="text"
        required
        maxlength="63"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        aria-describedby="slug-hint"
        value={v('slug')}
      />
    </div>
    <fieldset>
      <legend>{t('admin.content.new.locales')}</legend>
      {#each data.tenant.locales as l (l)}
        <div class="check">
          <input
            type="checkbox"
            id="locale-{l}"
            name="locales"
            value={l}
            checked={locales.includes(l)}
          />
          <label for="locale-{l}">{l}</label>
        </div>
      {/each}
    </fieldset>
    {#each data.tenant.locales as l (l)}
      <div class="field">
        <label for="title-{l}">{t('admin.content.field.title')} ({l})</label>
        <input
          id="title-{l}"
          name="title.{l}"
          type="text"
          maxlength="200"
          required={l === data.tenant.defaultLocale}
          value={v(`title.${l}`)}
        />
      </div>
    {/each}
    {#if data.patterns.length}
      <div class="field">
        <label for="pattern">{t('admin.content.new.pattern')}</label>
        <select id="pattern" name="patternId">
          <option value="">{t('admin.content.new.noPattern')}</option>
          {#each ['page', 'article'] as const as group (group)}
            {#if data.patterns.some((p) => p.type === group)}
              <optgroup label={t(`admin.content.type.${group}` as UiKey)}>
                {#each data.patterns.filter((p) => p.type === group) as p (p.id)}
                  <option value={p.id} selected={v('patternId') === p.id}>{name(p)}</option>
                {/each}
              </optgroup>
            {/if}
          {/each}
        </select>
      </div>
    {/if}
    <div class="actions">
      <button type="submit">{t('admin.content.new.submit')}</button>
    </div>
  </form>
</main>
