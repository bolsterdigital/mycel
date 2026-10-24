<!-- The fields of one block form (brief content-editor § B), rendered from the registry's field
     descriptions with the names `lib/editor/block-form.ts` reads back. Native controls only, so
     the form works without JavaScript: a localised field is one input per document locale, rich
     text a Markdown textarea, a caption a choice between the file's caption, none and its own, an
     optional group a "use" checkbox, a list its rows plus one empty row to add an entry. -->
<script lang="ts">
  import type { BlockField } from '@mycel/core';
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
    media: readonly Option[];
    items: readonly Option[];
    /** Names with a refusal, marked `aria-invalid`. */
    invalid: readonly string[];
    locale: string;
  }
  let { fields, values, locales, idPrefix, media, items, invalid, locale }: Props = $props();
  const t = $derived(ui(locale));
  const label = (key: string) => t(`admin.block.field.${key}` as UiKey);
  const v = (name: string) => values[name] ?? '';
  const id = (name: string) => `${idPrefix}-${name.replaceAll('.', '-')}`;
  const bad = (name: string) => invalid.includes(name) || undefined;
  const help = $derived(`${idPrefix}-markdown-help`);
  const hasRichText = (fs: readonly BlockField[]): boolean =>
    fs.some((f) => f.kind === 'rich-text' || ('fields' in f && hasRichText(f.fields)));
</script>

{#snippet input(name: string, text: string, multiline = false)}
  <div class="field">
    <label for={id(name)}>{text}</label>
    {#if multiline}
      <textarea id={id(name)} {name} rows="3" aria-invalid={bad(name)}>{v(name)}</textarea>
    {:else}
      <input id={id(name)} {name} type="text" value={v(name)} aria-invalid={bad(name)} />
    {/if}
  </div>
{/snippet}

{#snippet select(name: string, text: string, options: readonly Option[], empty?: string)}
  <div class="field">
    <label for={id(name)}>{text}</label>
    <select id={id(name)} {name} aria-invalid={bad(name)}>
      {#if empty !== undefined}<option value="">{empty}</option>{/if}
      {#each options as o (o.id)}
        <option value={o.id} selected={v(name) === o.id}>{o.label}</option>
      {/each}
    </select>
  </div>
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
      <fieldset>
        <legend>{label(f.key)} ({l})</legend>
        {@render select(
          `${name}.${l}.mode`,
          t('admin.block.caption.mode'),
          ['inherit', 'hide', 'own'].map((m) => ({
            id: m,
            label: t(`admin.block.caption.${m}` as UiKey),
          }))
        )}
        {@render input(`${name}.${l}`, t('admin.block.caption.own'), true)}
      </fieldset>
    {/each}
  {:else if f.kind === 'rich-text'}
    {#each locales as l (l)}
      <div class="field">
        <label for={id(`${name}.${l}`)}>{label(f.key)} ({l})</label>
        <textarea
          id={id(`${name}.${l}`)}
          name="{name}.{l}"
          rows="8"
          aria-describedby={help}
          aria-invalid={bad(`${name}.${l}`)}>{v(`${name}.${l}`)}</textarea
        >
      </div>
    {/each}
  {:else if f.kind === 'media'}
    {@render select(name, label(f.key), media, t('admin.block.none'))}
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
    <div class="check">
      <input type="checkbox" id={id(name)} {name} checked={v(name) === 'on'} />
      <label for={id(name)}>{label(f.key)}</label>
    </div>
  {:else if f.kind === 'actions'}
    {#each Array.from({ length: f.max }, (_, i) => i) as i (i)}
      <fieldset>
        <legend>{fill(t('admin.block.action'), { n: i + 1 })}</legend>
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
      </fieldset>
    {/each}
  {:else if f.kind === 'group'}
    <fieldset>
      <legend>{label(f.key)}</legend>
      {#if f.optional === 'omit'}
        <div class="check">
          <input
            type="checkbox"
            id={id(`${name}.present`)}
            name="{name}.present"
            checked={v(`${name}.present`) === 'on'}
          />
          <label for={id(`${name}.present`)}
            >{fill(t('admin.block.use'), { what: label(f.key) })}</label
          >
        </div>
      {/if}
      {#each f.fields as sub (sub.key)}
        {@render field(sub, `${name}.${sub.key}`)}
      {/each}
    </fieldset>
  {:else if f.kind === 'list'}
    {@const rows = Number(v(`${name}.rows`)) || 0}
    <input type="hidden" name="{name}.rows" value={rows} />
    {#each Array.from({ length: rows }, (_, i) => i) as i (i)}
      <fieldset>
        <legend>{label(f.key)} {i + 1}</legend>
        {#each f.fields as sub (sub.key)}
          {@render field(sub, `${name}.${i}.${sub.key}`)}
        {/each}
      </fieldset>
    {/each}
    <p class="muted">{t('admin.block.listHint')}</p>
  {/if}
{/snippet}

{#each fields as f (f.key)}
  {@render field(f, `p.${f.key}`)}
{/each}
{#if fields.length === 0}
  <p class="muted">{t('admin.block.noFields')}</p>
{/if}
{#if hasRichText(fields)}
  <details class="markdown-help" id={help}>
    <summary>{t('admin.block.markdown.title')}</summary>
    <ul>
      {#each ['headings', 'marks', 'lists', 'breaks', 'links', 'notes', 'escape'] as k (k)}
        <li>{t(`admin.block.markdown.${k}` as UiKey)}</li>
      {/each}
    </ul>
  </details>
{/if}
