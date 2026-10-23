<!-- The edit page of one item (TODO #11 A1): its status per locale, the document fields as one
     native form, links to the revisions and to a preview per locale in a new tab. A failed save
     comes back with what was typed; a conflict also shows who saved in between and what changed
     (ADR 018 rule 2). The blocks get their own forms in brief § B. The action group wraps whole
     buttons and links onto a new line when they do not fit (skill ui-action-layout). -->
<script lang="ts">
  import Diff from '#lib/admin/Diff.svelte';
  import Header from '#lib/admin/Header.svelte';
  import { fill, ui, type UiKey } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const values: Record<string, string | string[]> = $derived(form?.values ?? data.values);
  const v = (k: string): string => {
    const x = values[k];
    return typeof x === 'string' ? x : '';
  };
  const list = (k: string): string[] => {
    const x = values[k];
    return Array.isArray(x) ? x : [];
  };
  const docLocales = $derived(list('locales'));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const article = $derived(data.item.type === 'article');
  const title = $derived(
    (data.values[`title.${data.item.defaultLocale}`] as string | undefined) ||
      t('admin.content.untitled')
  );
  const baseRevision = $derived(v('baseRevisionId') || data.revision.id);
  const preview = (l: string) =>
    `${base}/preview/item/${data.item.id}?revision=${data.revision.id}&locale=${l}`;
</script>

<svelte:head>
  <title
    >{form ? `${t('error.prefix')} ` : ''}{title} · {data.tenant.name} · {t('admin.title')}</title
  >
</svelte:head>

{#snippet text(name: string, label: string, opts: { required?: boolean; max?: number } = {})}
  <div class="field">
    <label for={name}>{label}</label>
    <input
      id={name}
      {name}
      type="text"
      maxlength={opts.max ?? 200}
      required={opts.required}
      value={v(name)}
    />
  </div>
{/snippet}

{#snippet area(name: string, label: string, max: number)}
  <div class="field">
    <label for={name}>{label}</label>
    <textarea id={name} {name} maxlength={max} rows="3">{v(name)}</textarea>
  </div>
{/snippet}

<Header locale={data.locale} email={data.email} />
<main class="page admin">
  <h1>{title}</h1>
  <p><a href="{base}/content?type={data.item.type}">{t('admin.content.title')}</a></p>

  {#if form && !form.conflict}
    <div class="error-summary" role="alert">
      <h2>{t('error.summary.title')}</h2>
      <p>{t(form.error as UiKey)}</p>
    </div>
  {/if}
  {#if form?.conflict}
    <section class="error-summary" role="alert" aria-labelledby="conflict">
      <h2 id="conflict">{t('admin.content.conflict.title')}</h2>
      <p>
        {fill(t('admin.content.conflict.body'), {
          who: form.conflict.who,
          when: form.conflict.when,
        })}
      </p>
      <Diff rows={form.conflict.changes} locale={data.locale} />
    </section>
  {/if}
  {#if data.saved && !form}
    <div class="notice" role="status"><p>{t('admin.content.done.saved')}</p></div>
  {/if}

  <section aria-labelledby="state">
    <h2 id="state">{t('admin.content.state')}</h2>
    <p class="muted">/{data.item.slug} · {t(`admin.content.type.${data.item.type}` as UiKey)}</p>
    <ul class="tags">
      {#each data.item.publication as p (p.locale)}
        <li>
          {p.locale}: {t(`admin.content.status.${p.status}` as UiKey)}{#if p.changes}, {t(
              'admin.content.status.changes'
            )}{/if}
        </li>
      {/each}
    </ul>
    <p>{fill(t('admin.content.edit.revision'), data.revision)}</p>
    <p><a href="{base}/content/{data.item.id}/revisions">{t('admin.content.revisions')}</a></p>
  </section>

  <form method="post" action="?/save" class="card">
    <input type="hidden" name="baseRevisionId" value={baseRevision} />

    <fieldset>
      <legend>{t('admin.content.edit.fields')}</legend>
      <fieldset>
        <legend>{t('admin.content.new.locales')}</legend>
        <p class="muted">{t('admin.content.edit.localesHint')}</p>
        {#each data.locales as l (l)}
          <div class="check">
            <input
              type="checkbox"
              id="locale-{l}"
              name="locales"
              value={l}
              checked={docLocales.includes(l)}
            />
            <label for="locale-{l}">{l}</label>
          </div>
        {/each}
      </fieldset>
      {#each docLocales as l (l)}
        {@render text(`title.${l}`, `${t('admin.content.field.title')} (${l})`, {
          required: l === data.item.defaultLocale,
        })}
      {/each}
      {#if article}
        {#each docLocales as l (l)}
          {@render area(`lead.${l}`, `${t('admin.content.field.lead')} (${l})`, 1000)}
        {/each}
        <fieldset>
          <legend>{t('admin.content.field.authors')}</legend>
          {#if data.authors.length === 0}<p class="muted">
              {t('admin.content.edit.noAuthors')}
            </p>{/if}
          {#each data.authors as a (a.id)}
            <div class="check">
              <input
                type="checkbox"
                id="author-{a.id}"
                name="authorIds"
                value={a.id}
                checked={list('authorIds').includes(a.id)}
              />
              <label for="author-{a.id}">{a.name}</label>
            </div>
          {/each}
        </fieldset>
        <div class="field">
          <label for="sectionId">{t('admin.content.field.section')}</label>
          <select id="sectionId" name="sectionId">
            <option value="">{t('admin.content.edit.noSection')}</option>
            {#each data.sections as s (s.id)}
              <option value={s.id} selected={v('sectionId') === s.id}>{s.title}</option>
            {/each}
          </select>
        </div>
        {@render text('tags', t('admin.content.field.tags'), { max: 2000 })}
        <fieldset>
          <legend>{t('admin.content.field.corrections')}</legend>
          {#each data.corrections as c, i (i)}
            <p>{c.date}: {c.text[data.item.defaultLocale] ?? Object.values(c.text)[0]}</p>
          {/each}
          <div class="field">
            <label for="correctionDate">{t('admin.content.edit.correctionDate')}</label>
            <input
              id="correctionDate"
              name="correctionDate"
              type="date"
              value={v('correctionDate')}
            />
          </div>
          {#each docLocales as l (l)}
            {@render area(
              `correctionText.${l}`,
              `${t('admin.content.edit.correctionText')} (${l})`,
              2000
            )}
          {/each}
        </fieldset>
      {/if}
    </fieldset>

    <fieldset>
      <legend>{t('admin.content.edit.seo')}</legend>
      {#each docLocales as l (l)}
        {@render text(`seoTitle.${l}`, `${t('admin.content.field.seoTitle')} (${l})`)}
        {@render area(
          `seoDescription.${l}`,
          `${t('admin.content.field.seoDescription')} (${l})`,
          500
        )}
      {/each}
      <div class="check">
        <input type="checkbox" id="noindex" name="noindex" checked={v('noindex') === 'on'} />
        <label for="noindex">{t('admin.content.field.noindex')}</label>
      </div>
      {@render text('canonical', t('admin.content.field.canonical'), { max: 2048 })}
    </fieldset>

    <fieldset>
      <legend>{t('admin.content.edit.access')}</legend>
      <div class="field">
        <label for="level">{t('admin.content.field.level')}</label>
        <select id="level" name="level">
          {#each ['public', 'members', ...(v('level') === 'tier' ? ['tier'] : [])] as level (level)}
            <option value={level} selected={v('level') === level}
              >{t(`admin.content.level.${level}` as UiKey)}</option
            >
          {/each}
        </select>
      </div>
      <div class="field">
        <label for="teaser">{t('admin.content.field.teaser')}</label>
        <select id="teaser" name="teaser">
          {#each ['lead', 'marker', 'blocks'] as teaser (teaser)}
            <option value={teaser} selected={v('teaser') === teaser}
              >{t(`admin.content.teaser.${teaser}` as UiKey)}</option
            >
          {/each}
        </select>
      </div>
      <div class="field">
        <label for="teaserBlocks">{t('admin.content.field.teaserBlocks')}</label>
        <input
          id="teaserBlocks"
          name="teaserBlocks"
          type="number"
          min="0"
          max="200"
          value={v('teaserBlocks')}
        />
      </div>
    </fieldset>

    <p class="muted">{fill(t('admin.content.edit.blocks'), { n: data.blockCount })}</p>

    <div class="actions">
      <button type="submit">{t('admin.content.edit.save')}</button>
      {#each data.item.publication as p (p.locale)}
        <a class="button secondary" href={preview(p.locale)} target="_blank"
          >{fill(t('admin.content.edit.preview'), { locale: p.locale })}</a
        >
      {/each}
    </div>
  </form>
</main>
