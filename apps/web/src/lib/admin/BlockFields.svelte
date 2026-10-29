<!-- The fields of one block form (brief content-editor § B), rendered from the registry's field
     descriptions with the names `lib/editor/block-form.ts` reads back. Native controls only, so
     the form works without JavaScript: a localised field is one input per document locale, rich
     text a Markdown textarea, an image the shared MediaPicker (brief media-picker), a caption a
     choice between the file's caption, none and its own, an
     optional group a "use" checkbox, a list its rows plus one empty row to add an entry. The
     controls are the shared Field, Fieldset and Checkbox (brief #56), so a block form looks like
     every other form of the admin; a refusal marks its control and is listed in the summary. -->
<script lang="ts">
  import type { BlockField } from '@mycel/core';
  import { Checkbox, Field, Fieldset, MediaPicker } from './ui/index.js';
  import type { MediaChoice } from './media-choice.js';
  import { fill, ui, type UiKey } from '../../i18n/index.js';

  interface Option {
    id: string;
    label: string;
  }
  interface Props {
    fields: readonly BlockField[];
    values: Record<string, string>;
    locales: readonly string[];
    /** Unique per form on the page; element ids are `<idPrefix>-<name>`. */
    idPrefix: string;
    media: readonly MediaChoice[];
    /** The tenant's admin root, for the media picker's thumbnails, search and upload. */
    base: string;
    /** The operator may upload (`media:write`): the picker offers it. */
    upload: boolean;
    items: readonly Option[];
    /** Names with a refusal, marked `aria-invalid`. */
    invalid: readonly string[];
    locale: string;
  }
  let { fields, values, locales, idPrefix, media, base, upload, items, invalid, locale }: Props =
    $props();
  const t = $derived(ui(locale));
  const label = (key: string) => t(`admin.block.field.${key}` as UiKey);
  const v = (name: string) => values[name] ?? '';
  const id = (name: string) => `${idPrefix}-${name.replaceAll('.', '-')}`;
  const bad = (name: string) => invalid.includes(name);
  const help = $derived(`${idPrefix}-markdown-help`);
  const hasRichText = (fs: readonly BlockField[]): boolean =>
    fs.some((f) => f.kind === 'rich-text' || ('fields' in f && hasRichText(f.fields)));
</script>

{#snippet input(name: string, text: string, multiline = false)}
  <Field id={id(name)} label={text} {locale} invalid={bad(name)}>
    {#snippet control(attributes)}
      {#if multiline}
        <textarea {name} rows="3" {...attributes}>{v(name)}</textarea>
      {:else}
        <input {name} type="text" value={v(name)} {...attributes} />
      {/if}
    {/snippet}
  </Field>
{/snippet}

{#snippet select(name: string, text: string, options: readonly Option[], empty?: string)}
  <Field id={id(name)} label={text} {locale} invalid={bad(name)}>
    {#snippet control(attributes)}
      <select {name} {...attributes}>
        {#if empty !== undefined}<option value="">{empty}</option>{/if}
        {#each options as o (o.id)}
          <option value={o.id} selected={v(name) === o.id}>{o.label}</option>
        {/each}
      </select>
    {/snippet}
  </Field>
{/snippet}

{#snippet field(f: BlockField, name: string)}
  {#if f.kind === 'text'}
    {#if f.localized}
      {#each locales as l (l)}
        {@render input(`${name}.${l}`, `${label(f.key)} (${l})`, f.multiline)}
      {/each}
    {:else}
      {@render input(name, label(f.key), f.multiline)}
    {/if}
  {:else if f.kind === 'caption'}
    {#each locales as l (l)}
      <Fieldset legend="{label(f.key)} ({l})">
        {@render select(
          `${name}.${l}.mode`,
          t('admin.block.caption.mode'),
          ['inherit', 'hide', 'own'].map((m) => ({
            id: m,
            label: t(`admin.block.caption.${m}` as UiKey),
          }))
        )}
        {@render input(`${name}.${l}`, t('admin.block.caption.own'), true)}
      </Fieldset>
    {/each}
  {:else if f.kind === 'rich-text'}
    {#each locales as l (l)}
      <Field
        id={id(`${name}.${l}`)}
        label="{label(f.key)} ({l})"
        {locale}
        invalid={bad(`${name}.${l}`)}
      >
        {#snippet control(attributes)}
          <textarea name="{name}.{l}" rows="8" {...attributes} aria-describedby={help}
            >{v(`${name}.${l}`)}</textarea
          >
        {/snippet}
      </Field>
    {/each}
  {:else if f.kind === 'media'}
    <MediaPicker
      id={id(name)}
      {name}
      label={label(f.key)}
      {locale}
      value={v(name)}
      options={media}
      {base}
      {upload}
      invalid={bad(name)}
    />
  {:else if f.kind === 'reference' && f.to === 'item'}
    {@render select(name, label(f.key), items, t('admin.block.none'))}
  {:else if f.kind === 'reference'}
    {@render input(name, label(f.key))}
  {:else if f.kind === 'choice'}
    {@render select(
      name,
      label(f.key),
      f.options.map((o) => ({ id: o, label: t(`admin.block.option.${o}` as UiKey) }))
    )}
  {:else if f.kind === 'boolean'}
    <Checkbox id={id(name)} {name} label={label(f.key)} checked={v(name) === 'on'} />
  {:else if f.kind === 'actions'}
    {#each Array.from({ length: f.max }, (_, i) => i) as i (i)}
      <Fieldset legend={fill(t('admin.block.action'), { n: i + 1 })}>
        {#each locales as l (l)}
          {@render input(`${name}.${i}.label.${l}`, `${t('admin.block.field.label')} (${l})`)}
        {/each}
        {@render select(
          `${name}.${i}.target`,
          t('admin.block.field.target'),
          [{ id: 'url', label: t('admin.block.target.url') }, ...items],
          t('admin.block.none')
        )}
        {@render input(`${name}.${i}.url`, t('admin.block.field.url'))}
      </Fieldset>
    {/each}
  {:else if f.kind === 'group'}
    <Fieldset legend={label(f.key)}>
      {#if f.optional === 'omit'}
        <Checkbox
          id={id(`${name}.present`)}
          name="{name}.present"
          label={fill(t('admin.block.use'), { what: label(f.key) })}
          checked={v(`${name}.present`) === 'on'}
        />
      {/if}
      {#each f.fields as sub (sub.key)}
        {@render field(sub, `${name}.${sub.key}`)}
      {/each}
    </Fieldset>
  {:else if f.kind === 'list'}
    {@const rows = Number(v(`${name}.rows`)) || 0}
    <input type="hidden" name="{name}.rows" value={rows} />
    {#each Array.from({ length: rows }, (_, i) => i) as i (i)}
      <Fieldset legend="{label(f.key)} {i + 1}">
        {#each f.fields as sub (sub.key)}
          {@render field(sub, `${name}.${i}.${sub.key}`)}
        {/each}
      </Fieldset>
    {/each}
    <p class="ui-hint">{t('admin.block.listHint')}</p>
  {/if}
{/snippet}

{#each fields as f (f.key)}
  {@render field(f, `p.${f.key}`)}
{/each}
{#if fields.length === 0}
  <p class="ui-hint">{t('admin.block.noFields')}</p>
{/if}
{#if hasRichText(fields)}
  <details class="ui-fold markdown-help" id={help}>
    <summary>{t('admin.block.markdown.title')}</summary>
    <ul>
      {#each ['headings', 'marks', 'lists', 'breaks', 'links', 'notes', 'escape'] as k (k)}
        <li>{t(`admin.block.markdown.${k}` as UiKey)}</li>
      {/each}
    </ul>
  </details>
{/if}
