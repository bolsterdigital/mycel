<!-- The fields of one block form (brief content-editor § B), rendered from the registry's field
     descriptions with the names `lib/editor/block-form.ts` reads back. Native controls only, so
     the form works without JavaScript: a localised field is one input per locale asked for (the
     edit screen asks for one, #66 PR 4, and then names no locale in its labels), rich
     text a Markdown textarea, an image the shared MediaPicker (brief media-picker), a caption a
     choice between the file's caption, none and its own, an
     optional group a "use" checkbox, a list its rows plus one empty row to add an entry. The
     controls are the shared Field, Fieldset and Checkbox (brief #56), so a block form looks like
     every other form of the admin; a refusal marks its control and is listed in the summary.
     With `groups` (MY-110 A), the content fields come first and the rarer ones fold under
     "Display" and "Source and credits"; a fold with a refused field starts open. An image's
     caption says what it inherits from the file; its alt field is marked for the screen's
     script, which hides it while the image is decorative and the field is empty.
     With `row`, one list is shown as the row the site shows: its entries side by side,
     typed in place, its style a choice above them; adding, moving and removing an entry are
     submits to `arrange`, which shows the form again with nothing saved, so the row changes the
     same way with and without JavaScript. -->
<script lang="ts">
  import HeroAltRow from '../hero-alt/HeroAltRow.svelte';
  import WritingSurface from '#lib/editor/WritingSurface.svelte';
  import { toTiptap } from '#lib/editor/article-document.js';
  import { fromMarkdown } from '#lib/editor/markdown.js';
  import { BLOCK_DEFINITIONS, type BlockField, type BlockType } from '@mycel/core';
  import RowCard from './RowCard.svelte';
  import TargetPicker from './TargetPicker.svelte';
  import { Button, Checkbox, Choices, Field, Fieldset, Icon, MediaPicker } from '../ui/index.js';
  import type { MediaChoice } from '../media-choice.js';
  import { fill, ui, type UiKey } from '../../../i18n/index.js';

  interface Option {
    id: string;
    label: string;
  }
  interface Props {
    fields?: readonly BlockField[];
    block?: {
      type: BlockType;
      image: {
        description?: {
          image: string;
          alt: Record<string, string> | null;
          locales: readonly string[];
        };
      } | null;
    };
    values: Record<string, string>;
    locales: readonly string[];
    /** Unique per block on the page; element ids are `<idPrefix>-<name without prefix>`. */
    idPrefix: string;
    /** In front of every field name, for a block inside the one edit form (`b.<id>.`, #66 PR 2). */
    prefix?: string;
    media: readonly MediaChoice[];
    /** The tenant's admin root, for the media picker's thumbnails, search and upload. */
    base: string;
    /** The operator may upload (`media:write`): the picker offers it. */
    upload: boolean;
    items?: readonly Option[];
    references?: {
      items: readonly Option[];
      people: readonly Option[];
      personGroups: readonly Option[];
    };
    people?: readonly Option[];
    personGroups?: readonly Option[];
    /** Names with a refusal, marked `aria-invalid`. */
    invalid: readonly string[];
    locale: string;
    /** Top-level keys folded under "Display" and "Source and credits", with their legends. */
    groups?:
      | {
          display: readonly string[];
          source: readonly string[];
          labels: { display: string; source: string };
        }
      | undefined;
    /** One list shown as a row, and its style key (BLOCK_PRESENTATION). */
    row?: { list: string; style: string } | undefined;
    imageDescription?: {
      image: string;
      alt: Record<string, string> | null;
      locales: readonly string[];
    };
  }
  let {
    fields: suppliedFields,
    block,
    values,
    locales,
    idPrefix,
    prefix = '',
    media,
    base,
    upload,
    references,
    items = [],
    people = [],
    personGroups = [],
    invalid,
    locale,
    groups,
    row,
    imageDescription: suppliedDescription,
  }: Props = $props();
  const fields = $derived(suppliedFields ?? (block ? BLOCK_DEFINITIONS[block.type].fields : []));
  const imageDescription = $derived(suppliedDescription ?? block?.image?.description);
  const t = $derived(ui(locale));
  /** The edit screen's `arrange` action, in the locale the form shows, as every action carries. */
  const arrange = $derived(`?/arrange&locale=${encodeURIComponent(locales[0] ?? '')}`);
  const label = (key: string) => t(`admin.block.field.${key}` as UiKey);
  const option = (o: string) => t(`admin.block.option.${o}` as UiKey);
  const v = (name: string) => values[name] ?? '';
  const id = (name: string) => `${idPrefix}-${name.slice(prefix.length).replaceAll('.', '-')}`;
  const bad = (name: string) => invalid.includes(name);
  const help = $derived(`${idPrefix}-markdown-help`);
  /** " (en)" after a localised label, only when the form shows more than one locale. */
  const per = (l: string) => (locales.length > 1 ? ` (${l})` : '');
  const prose = (value: string) => {
    const read = fromMarkdown(value);
    return read.ok ? toTiptap(read.doc) : null;
  };
  /**
   * What the editor opens with: after a refused save its own posted document, because the textarea
   * behind it still holds the words it loaded (#130). Rejected: writing every keystroke back into
   * the textarea, which would run Markdown over a document on each change.
   */
  const surfaceContent = (name: string) => {
    const posted = v(`${name}.editor`);
    if (!posted) return prose(v(name));
    try {
      return JSON.parse(posted) as ReturnType<typeof prose>;
    } catch {
      return prose(v(name));
    }
  };
  /** The file a caption field's image points at, for the caption it inherits. */
  const assetOf = (captionName: string) =>
    media.find((m) => m.id === v(captionName.replace(/caption$/, 'mediaId')));
  const inGroup = (key: string) =>
    (!!groups && (groups.display.includes(key) || groups.source.includes(key))) ||
    (!!row && (key === row.list || key === row.style));
  const rowList = $derived(
    row
      ? fields.find(
          (f): f is Extract<BlockField, { kind: 'list' }> => f.key === row.list && f.kind === 'list'
        )
      : undefined
  );
  const rowStyle = $derived(
    row
      ? fields.find(
          (f): f is Extract<BlockField, { kind: 'choice' }> =>
            f.key === row.style && f.kind === 'choice'
        )
      : undefined
  );
  /** A group starts open when a refusal names one of its fields. */
  const refusedIn = (keys: readonly string[]) =>
    keys.some((k) => invalid.some((name) => name.startsWith(`${prefix}p.${k}`)));
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

{#snippet dateInput(name: string, text: string)}
  <Field id={id(name)} label={text} {locale} invalid={bad(name)}>
    {#snippet control(attributes)}
      <input {name} type="date" value={v(name)} {...attributes} />
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
    {#if imageDescription && name === `${prefix}p.alt`}
      {@const work = locales[0] ?? locale}
      {@const saved = imageDescription}
      <HeroAltRow
        {locale}
        {work}
        locales={saved.locales}
        image={v(`${prefix}p.mediaId`)}
        savedImage={saved.image}
        text={v(`${name}.${work}`)}
        savedText={saved.alt?.[work] ?? ''}
        others={Object.fromEntries(
          saved.locales.filter((l) => l !== work).map((l) => [l, saved.alt?.[l]])
        )}
        clearing={v(`${prefix}imageAltClear`) === 'on'}
        flagged={bad(`${name}.${work}`) || bad(name)}
        fieldId={id(`${name}.${work}`)}
        fieldName={`${name}.${work}`}
        clearName={`${prefix}imageAltClear`}
        markerName={`${prefix}imageAltShown`}
        imageName={`${prefix}p.mediaId`}
        block
      />
    {:else if f.localized && f.key === 'alt'}
      <div class="ui-block-alt" data-alt-of={name.replace(/alt$/, 'decorative')}>
        {#each locales as l (l)}
          {@render input(`${name}.${l}`, `${label(f.key)}${per(l)}`, f.multiline)}
        {/each}
      </div>
    {:else if f.localized}
      {#each locales as l (l)}
        {@render input(`${name}.${l}`, `${label(f.key)}${per(l)}`, f.multiline)}
      {/each}
    {:else}
      {@render input(name, label(f.key), f.multiline)}
    {/if}
  {:else if f.kind === 'caption'}
    {#each locales as l (l)}
      <Fieldset legend="{label(f.key)}{per(l)}">
        {@render select(
          `${name}.${l}.mode`,
          t('admin.block.caption.mode'),
          ['inherit', 'hide', 'own'].map((m) => ({
            id: m,
            label: t(`admin.block.caption.${m}` as UiKey),
          }))
        )}
        {@render input(`${name}.${l}`, t('admin.block.caption.own'), true)}
        {@const asset = assetOf(name)}
        {#if asset?.card}
          <p class="ui-hint">
            {asset.card.caption[l]?.trim()
              ? fill(t('admin.block.caption.inherited'), { caption: asset.card.caption[l]! })
              : t('admin.block.caption.noneInherited')}
          </p>
        {/if}
      </Fieldset>
    {/each}
  {:else if f.kind === 'rich-text'}
    {#each locales as l (l)}
      {#if prefix !== 'new.' && surfaceContent(`${name}.${l}`)}
        <WritingSurface
          content={surfaceContent(`${name}.${l}`)}
          name="{name}.{l}.editor"
          {locale}
          contentLocale={l}
          nativeId={id(`${name}.${l}`)}
          value={v(`${name}.${l}.editor`)}
        />
      {/if}
      <Field
        id={id(`${name}.${l}`)}
        label="{label(f.key)}{per(l)}"
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
      accept={f.accept ?? 'image'}
      {base}
      {upload}
      invalid={bad(name)}
    />
  {:else if f.kind === 'reference' && f.to === 'item'}
    {@render select(name, label(f.key), references?.items ?? items, t('admin.block.none'))}
  {:else if f.kind === 'reference' && f.key === 'photographerPersonId'}
    <Choices
      id={id(name)}
      {name}
      legend={label(f.key)}
      {locale}
      searchable
      selected={[v(name)]}
      options={[
        { value: '', label: t('admin.block.none') },
        ...(references?.people ?? people).map((p) => ({ value: p.id, label: p.label })),
      ]}
    />
  {:else if f.kind === 'reference' && (f.to === 'person' || f.to === 'person_group')}
    {@render select(
      name,
      label(f.key),
      f.to === 'person'
        ? (references?.people ?? people)
        : (references?.personGroups ?? personGroups),
      t('admin.block.none')
    )}
  {:else if f.kind === 'reference'}
    {@render input(name, label(f.key))}
  {:else if f.kind === 'choice'}
    {@render select(
      name,
      label(f.key),
      f.options.map((o) => ({ id: o, label: option(o) }))
    )}
  {:else if f.kind === 'date'}
    {@render dateInput(name, label(f.key))}
  {:else if f.kind === 'boolean' && !(imageDescription && name === `${prefix}p.decorative`)}
    <Checkbox id={id(name)} {name} label={label(f.key)} checked={v(name) === 'on'} />
  {:else if f.kind === 'actions'}
    {#each Array.from({ length: f.max }, (_, i) => i) as i (i)}
      <Fieldset legend={fill(t('admin.block.action'), { n: i + 1 })}>
        {#each locales as l (l)}
          {@render input(`${name}.${i}.label.${l}`, `${t('admin.block.field.label')}${per(l)}`)}
        {/each}
        {@const target = `${name}.${i}.target`}
        <TargetPicker
          id={id(target)}
          choices="{base}/content/choices?locale={encodeURIComponent(locales[0] ?? locale)}"
          {locale}
          refused={bad(target) || bad(`${name}.${i}.url`)}
        >
          {@render select(
            target,
            t('admin.block.field.target'),
            [{ id: 'url', label: t('admin.block.target.url') }, ...(references?.items ?? items)],
            t('admin.block.none')
          )}
          {@render input(`${name}.${i}.url`, t('admin.block.field.url'))}
        </TargetPicker>
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

{#snippet rowEditor(
  list: Extract<BlockField, { kind: 'list' }>,
  style: Extract<BlockField, { kind: 'choice' }> | undefined,
  arrange: string
)}
  {@const name = `${prefix}p.${list.key}`}
  {@const rows = Number(v(`${name}.rows`)) || 0}
  {@const styleName = `${prefix}p.${style?.key}`}
  {@const step = (move: string, i: number) => `${name}|${move}|${i}`}
  <div class="ui-row-editor">
    {#if style}
      <fieldset class="ui-row-style">
        <legend>{t('admin.block.row.style')}</legend>
        {#each style.options as o (o)}
          <label
            ><input
              type="radio"
              name={styleName}
              value={o}
              checked={(v(styleName) || style.options[0]) === o}
            />
            {option(o)}</label
          >
        {/each}
      </fieldset>
    {/if}
    <input type="hidden" name="{name}.rows" value={rows} />
    <ol class="ui-row-grid" data-count={rows} data-style={v(styleName) || style?.options[0]}>
      {#each Array.from({ length: rows }, (_, i) => i) as i (i)}
        <RowCard>
          <div class="ui-row-head">
            <span class="ui-row-number">{fill(t('admin.block.row.card'), { n: i + 1 })}</span>
            <details class="ui-row-more">
              <summary aria-label={fill(t('admin.block.row.moreFor'), { n: i + 1 })}
                ><Icon name="ellipsis" /><span>{t('admin.block.row.more')}</span></summary
              >
              <div class="ui-row-menu">
                {#if i > 0}
                  <button
                    type="submit"
                    formaction={arrange}
                    formnovalidate
                    name="arrange"
                    value={step('earlier', i)}
                    ><Icon name="arrow-left" />{t('admin.block.row.earlier')}</button
                  >
                {/if}
                {#if i < rows - 1}
                  <button
                    type="submit"
                    formaction={arrange}
                    formnovalidate
                    name="arrange"
                    value={step('later', i)}
                    ><Icon name="arrow-right" />{t('admin.block.row.later')}</button
                  >
                {/if}
                {#if rows > list.min}
                  <button
                    class="danger"
                    type="submit"
                    formaction={arrange}
                    formnovalidate
                    name="arrange"
                    value={step('remove', i)}
                    ><Icon name="trash-2" />{t('admin.block.row.remove')}</button
                  >
                {:else}
                  <p class="ui-hint">{fill(t('admin.block.row.atLeast'), { n: list.min })}</p>
                {/if}
              </div>
            </details>
          </div>
          <input type="hidden" name="{name}.{i}.from" value={v(`${name}.${i}.from`)} />
          {#each list.fields as sub (sub.key)}
            {@render field(sub, `${name}.${i}.${sub.key}`)}
          {/each}
        </RowCard>
      {/each}
    </ol>
    <div class="ui-row-add">
      {#if rows < list.max}
        <Button
          variant="secondary"
          formaction={arrange}
          formnovalidate
          name="arrange"
          value={step('add', rows)}><Icon name="plus" />{t('admin.block.row.add')}</Button
        >
      {/if}
      <span class="ui-hint">{fill(t('admin.block.row.count'), { n: rows, max: list.max })}</span>
    </div>
  </div>
{/snippet}

{#if row && rowList}{@render rowEditor(rowList, rowStyle, arrange)}{/if}
{#each fields as f (f.key)}
  {#if !inGroup(f.key)}{@render field(f, `${prefix}p.${f.key}`)}{/if}
{/each}
{#if groups}
  {#each [['display', groups.display], ['source', groups.source]] as const as [kind, keys] (kind)}
    {#if keys.length}
      <details class="ui-fold ui-block-group" open={refusedIn(keys)}>
        <summary>{groups.labels[kind]}</summary>
        {#each fields.filter((f) => keys.includes(f.key)) as f (f.key)}
          {@render field(f, `${prefix}p.${f.key}`)}
        {/each}
      </details>
    {/if}
  {/each}
{/if}
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
