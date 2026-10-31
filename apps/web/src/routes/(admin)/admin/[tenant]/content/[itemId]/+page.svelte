<!-- The edit screen of one item (TODO #66 PR 2, brief edit-screen § 4): one form for the whole
     document, under an ItemBar with the state in words, Preview and Save. The main column has four
     sections a script may show as tabs (#66 PR 6): Content (the title large and first, the lead,
     the hero image and the blocks in reading order, as the page shows them), Featured (how the item
     appears elsewhere: image, title, description; #86), Search and sharing, and Settings (access
     only on an item that has it, corrections, languages), the last two folded. Under every empty
     field that inherits, `Inherited` names what applies instead and where it comes from, from
     core's chain (`effective`), never derived here. Each block is a BlockCard in the same form (#66
     PR 3, MY-110 A): at rest it shows what the page will (an image as its picture with caption and
     credit, `lib/admin/block-presentation.ts` says per type), "Edit" opens its fields with the
     rarer ones folded under "Display" and "Source and credits", and "More actions" holds move,
     duplicate and remove (a confirmation in place); a "+" above each card inserts an empty block
     there (stored with the next save); every such button saves what was typed first. The screen's
     script (`/_admin/edit-screen.js`, #66 PR 6) adds the save state in the bar, Ctrl/Cmd+S, the
     leave warning, Escape and the focus after a block action; Enter in a text field saves through a
     hidden default button. The side column has the status card of each locale (the state in words,
     the main action by state, scheduling folded, view on the site) and "This item" (address,
     authors, section and tags as WordPress and Ghost have them, revisions). A failed save comes
     back with what was typed and every fold open; a conflict also shows who saved in between and
     what changed (ADR 018 rule 2). The restricted note comes before every publication button and
     cannot be closed (ADR 018 rule 6).
     One locale at a time (#66 PR 4): every field shows the content locale only, without a locale
     in its label; the bar's LocaleSwitch saves and shows another locale with where each stands;
     the side column has that locale's status card and the other locales as one line each. A
     locale the item lacks shows "start the translation" in place of the content. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { earlyInput } from '#lib/editor/early-input.js';
  import WritingSurface from '#lib/editor/WritingSurface.svelte';
  import BlockFields from '#lib/admin/BlockFields.svelte';
  import Diff from '#lib/admin/Diff.svelte';
  import Inherited from '#lib/admin/Inherited.svelte';
  import { issueLabel } from '#lib/admin/issue-label.js';
  import {
    Actions,
    BlockCard,
    BlockImage,
    BlockSummary,
    Button,
    Checkbox,
    Choices,
    ConfirmAction,
    EditPage,
    EmptyState,
    Field,
    Fieldset,
    Icon,
    ItemBar,
    LocaleSwitch,
    MediaPicker,
    MetaList,
    Notice,
    Select,
    StatusCard,
    Tabs,
  } from '#lib/admin/ui/index.js';
  import { BLOCK_PRESENTATION } from '#lib/admin/block-presentation.js';
  import { BLOCK_DEFINITIONS, type BlockType, type MediaCredit } from '@mycel/core';
  import { fill, ui, type UiKey } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  onMount(() => {
    // These modules change disclosure state; start them after hydration has claimed the form.
    for (const src of [
      '/_admin/tabs.js',
      ...(data.canWrite ? ['/_admin/edit-screen.js'] : []),
      ...(!data.translating && data.item.type === 'page' && data.canWrite
        ? ['/_admin/live-preview-parent.js']
        : []),
    ]) {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = src;
      document.head.append(script);
    }
  });
  const early = earlyInput('item-edit');
  const earlyProse = Object.keys(early).some((name) =>
    data.blocks.some((b) => b.type === 'rich-text' && name.startsWith(`b.${b.id}.`))
  );
  const posted = $derived(form && 'values' in form ? form.values : null);
  const values: Record<string, string | string[]> = $derived({
    ...(posted ?? data.values),
    ...early,
  });
  const v = (k: string): string => {
    const x = values[k];
    return typeof x === 'string' ? x : '';
  };
  const list = (k: string): string[] => {
    const x = values[k];
    return Array.isArray(x) ? x : [];
  };
  const authors = $derived((form && 'authors' in form ? form.authors : null) ?? data.authors);
  const sections = $derived((form && 'sections' in form ? form.sections : null) ?? data.sections);
  const pending = $derived(form && 'pending' in form ? form.pending : data.pending);
  const issues = $derived<{ name: string; copy: string }[]>(
    form && 'fieldIssues' in form ? (form.fieldIssues ?? []) : []
  );
  const docLocales = $derived(list('locales'));
  /** The one locale the screen shows (#66 PR 4); its fields only, while the item has it. */
  const work = $derived(data.workLocale);
  const shown = $derived(data.translating ? [] : [work]);
  /** The site has more than one locale: the switch shows (table stake 13). */
  const multi = $derived(data.translations.length > 1);
  const base = $derived(`/admin/${data.tenant.slug}`);
  const article = $derived(data.item.type === 'article');
  const defaultLocale = $derived(data.item.defaultLocale);
  const title = $derived(
    (data.values[`title.${work}`] as string | undefined) ||
      (data.values[`title.${defaultLocale}`] as string | undefined) ||
      t('admin.content.untitled')
  );
  const typeName = $derived(t(`admin.content.type.${data.item.type}` as UiKey));
  const baseRevision = $derived(v('baseRevisionId') || data.revision.id);
  /** Folded groups open after a failed save, so a field the summary links to is in view. */
  const folded = $derived(!form);
  const mainPublication = $derived(
    data.translating ? undefined : data.item.publication.find((p) => p.locale === work)
  );
  /** Every other locale of the site, one line each in the side column. */
  const others = $derived(
    data.translations
      .filter((x) => x.locale !== work)
      .map((x) => ({ ...x, publication: data.item.publication.find((p) => p.locale === x.locale) }))
  );
  const stateWords = (s: 'ok' | 'behind' | 'missing') =>
    s === 'behind'
      ? t('admin.locale.state.behind')
      : s === 'missing'
        ? t('admin.locale.state.missing')
        : '';
  const dateOf = $derived(
    new Intl.DateTimeFormat(data.locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: data.timeZone,
    })
  );

  type Publication = (typeof data.item.publication)[number];
  type Tone = 'neutral' | 'info' | 'success' | 'warning';
  /** A locale's state in words (brief edit-screen table stake 8). */
  const stateOf = (p: Publication): { text: string; tone: Tone } => {
    if (p.live && p.changes) return { text: t('admin.content.state.changed'), tone: 'warning' };
    if (p.live)
      return {
        text: fill(t('admin.content.state.live'), {
          date: p.publishedAt ? dateOf.format(new Date(p.publishedAt)) : '',
        }),
        tone: 'success',
      };
    if (p.pin)
      return { text: fill(t('admin.content.state.pinned'), { at: p.pin.at }), tone: 'info' };
    if (p.status === 'unpublished')
      return { text: t('admin.content.state.offline'), tone: 'neutral' };
    return { text: t('admin.content.state.draft'), tone: 'neutral' };
  };

  /** The document fields a refused save can name (`documentFieldIssues`), with their label. */
  const DOC_FIELDS: Record<string, UiKey> = {
    canonical: 'admin.content.field.canonical',
    tags: 'admin.content.field.tags',
    level: 'admin.content.field.level',
    teaser: 'admin.content.field.teaser',
    teaserBlocks: 'admin.content.field.teaserBlocks',
    locales: 'admin.content.new.locales',
    correctionDate: 'admin.content.edit.correctionDate',
  };
  /** Whether a refused save named this field. */
  const flagged = (name: string) => issues.some((i) => i.name === name);
  /** A field name as words: a document field's label, or a block field's plus its locale. */
  const fieldLabel = (name: string): string => {
    if (name in DOC_FIELDS) return t(DOC_FIELDS[name]!);
    const parts = name
      .replace(/^(b\.[^.]+|new)\./, '')
      .split('.')
      .slice(1);
    const locale = data.docLocales.includes(parts.at(-1) ?? '') ? parts.pop() : null;
    const key = [...parts].reverse().find((p) => !/^\d+$/.test(p) && p !== 'mode');
    const label = key ? t(`admin.block.field.${key}` as UiKey) : t('admin.block.title');
    return locale ? `${label} (${locale})` : label;
  };
  /** The element id of a block field: `b-<block id>-p-…`, `b-new-p-…` for the pending block. */
  const fieldId = (name: string) =>
    name === 'locales'
      ? `locale-${defaultLocale}`
      : name in DOC_FIELDS
        ? name
        : name.startsWith('new.')
          ? `b-new-${name.slice(4).replaceAll('.', '-')}`
          : `b-${name.slice(2).replaceAll('.', '-')}`;
  /** An issue path in words: "Titel (en)", "Blok 3: Tekst (nl)", else the path itself. */
  const issueName = (path: string): string => {
    const l = issueLabel(path, data.docLocales);
    if (!l) return path;
    const label = t(l.key as UiKey);
    const named =
      l.block === null ? label : fill(t('admin.content.issue.block'), { n: l.block, field: label });
    return l.locale ? `${named} (${l.locale})` : named;
  };
  const previewHref = (l: string) =>
    `${base}/preview/item/${data.item.id}?revision=${data.revision.id}&locale=${l}`;
  /** The locales the item can start from: those it has, its default first. */
  const sources = $derived([
    ...data.docLocales.filter((l) => l === defaultLocale),
    ...data.docLocales.filter((l) => l !== defaultLocale),
  ]);
  /** The live preview of unsaved fields (#11 D): pages, for a member who can write. */
  const livePreview = $derived(!article && data.canWrite);
  const assist = (params: Record<string, string>) =>
    `${base}/content/${data.item.id}/assist?${new URLSearchParams(params)}`;
  /** The values of a block's fields: what a refused post typed, else what is stored. */
  const blockValues = (b: (typeof data.blocks)[number]): Record<string, string> => {
    if (!posted && !Object.keys(early).length) return b.values;
    const prefix = `b.${b.id}.`;
    const typed = Object.entries({ ...posted, ...early }).filter(
      (e): e is [string, string] => e[0].startsWith(prefix) && typeof e[1] === 'string'
    );
    return { ...b.values, ...Object.fromEntries(typed) };
  };
  /** The chain of one locale (#86); images are the same in every locale. */
  const chain = (l: string) => data.effective[l] ?? data.effective[defaultLocale]!;
  /** Whether a field is empty both as typed and as stored, so what it inherits applies. */
  const empty = (name: string) => !v(name).trim() && !data.values[name];
  const thumbOf = (id: string | null) =>
    id && data.media.some((m) => m.id === id && m.thumb) ? `${base}/media/${id}/thumb` : null;
  const cardLabels = $derived({
    edit: t('admin.block.card.edit'),
    done: t('admin.block.card.done'),
    more: t('admin.block.card.more'),
  });
  const groupLabels = $derived({
    display: t('admin.block.group.display'),
    source: t('admin.block.group.source'),
  });
  /** A credit as the page words it (`lib/blocks/Credit.svelte`), in the content locale. */
  const creditLine = (c: MediaCredit): string =>
    [
      c.work ? `${c.work.title}, ${c.work.maker}` : '',
      c.photographer ? fill(ui(work)('block.credit.photographer'), { name: c.photographer }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const blockTypeOptions = $derived(
    data.blockTypes.map((type) => ({
      value: type,
      label: t(`admin.block.type.${type}` as UiKey),
    }))
  );
</script>

<svelte:head>
  <title
    >{form ? `${t('error.prefix')} ` : ''}{title} · {data.tenant.name} · {t('admin.title')}</title
  >
</svelte:head>

{#snippet translateLinks(field: string, target: string, locale: string, label: string)}
  {#if data.assistEnabled}
    {@const sources = docLocales.filter(
      (source: string) => source !== locale && !!v(`${field}.${source}`)
    )}
    {#if sources.length}
      <p class="ui-hint">
        {#each sources as source (source)}
          <a href={assist({ task: 'translate', from: source, to: locale, target })}>
            {fill(t('admin.assist.translateFrom'), { locale: source })}
            {label} ({locale})
          </a>
        {/each}
      </p>
    {/if}
  {/if}
{/snippet}

{#snippet text(name: string, label: string, opts: { required?: boolean; max?: number } = {})}
  <Field
    id={name}
    {name}
    {label}
    locale={data.locale}
    maxlength={opts.max ?? 200}
    required={opts.required ?? false}
    invalid={flagged(name)}
    value={v(name)}
  />
{/snippet}

{#snippet area(name: string, label: string, max: number)}
  <Field id={name} {label} locale={data.locale}>
    {#snippet control(attributes)}
      <textarea {name} maxlength={max} rows="3" {...attributes}>{v(name)}</textarea>
    {/snippet}
  </Field>
{/snippet}

{#snippet issueList(list: { path: string; field: string | null; copy: string }[])}
  <ul>
    {#each list as i (i.path + i.copy)}
      <li>
        {#if i.field}<a href="#{i.field}">{issueName(i.path)}</a>{:else}{issueName(i.path)}{/if}: {t(
          i.copy as UiKey
        )}
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet pendingCard(p: NonNullable<typeof pending>)}
  <section id="block-new" class="ui-panel pending" aria-labelledby="block-new-title">
    <h4 id="block-new-title">
      {fill(t('admin.block.new'), { type: t(`admin.block.type.${p.type}` as UiKey) })}
    </h4>
    <p class="ui-hint">{t('admin.block.new.hint')}</p>
    {#each Object.entries(p.hidden) as [name, value] (name)}
      <input type="hidden" {name} {value} />
    {/each}
    <BlockFields
      fields={BLOCK_DEFINITIONS[p.type as BlockType].fields}
      values={{
        ...p.values,
        ...Object.fromEntries(
          Object.entries(early).filter((e): e is [string, string] => typeof e[1] === 'string')
        ),
      }}
      locales={shown}
      idPrefix="b-new"
      prefix="new."
      media={data.media}
      {base}
      upload={data.upload}
      items={data.items}
      invalid={issues.map((x) => x.name)}
      locale={data.locale}
    />
    <Actions>
      <Button formaction="?/save">{t('admin.block.new.add')}</Button>
      <Button variant="secondary" formaction="?/discard" formnovalidate
        >{t('admin.block.new.discard')}</Button
      >
    </Actions>
  </section>
{/snippet}

{#snippet blockRest(b: (typeof data.blocks)[number])}
  {#if BLOCK_PRESENTATION[b.type].rest === 'image' && b.image}
    {@const img = b.image}
    <BlockImage
      src={img.card ? `${base}/media/${img.mediaId}/variant/${img.card.file}` : null}
      width={img.card?.width ?? 4}
      height={img.card?.height ?? 3}
      caption={img.caption}
      credit={img.credit ? creditLine(img.credit) : null}
      missing={fill(t('admin.block.image.missing'), { file: img.label })}
      replace={{ href: `#b-${b.id}-p-mediaId`, label: t('admin.block.image.replace') }}
    />
  {:else}
    {@const image = b.preview.mediaId
      ? data.media.find((m) => m.id === b.preview.mediaId && m.thumb)
      : undefined}
    <BlockSummary
      text={b.preview.text}
      thumb={image ? `${base}/media/${image.id}/thumb` : null}
      entries={b.preview.entries}
      empty={t('admin.block.emptySummary')}
    />
  {/if}
{/snippet}

{#snippet blockCard(b: (typeof data.blocks)[number], i: number)}
  {@const prefix = `b.${b.id}.`}
  {@const refused = issues.some((x) => x.name.startsWith(prefix))}
  {@const shape = BLOCK_PRESENTATION[b.type]}
  <BlockCard
    id="block-{b.id}"
    class="block"
    title="{i + 1}. {t(`admin.block.type.${b.type}` as UiKey)}"
    open={refused ||
      data.openBlocks.includes(b.id) ||
      (Array.isArray(early.$openBlocks) && early.$openBlocks.includes(b.id))}
    labels={cardLabels}
  >
    {#snippet rest()}{@render blockRest(b)}{/snippet}
    {#snippet actions()}
      {#if data.canWrite}
        {#if i > 0}
          <Button variant="secondary" formaction="?/move" name="move" value="{b.id}:up"
            >{t('admin.block.move.up')}</Button
          >
        {/if}
        {#if i < data.blocks.length - 1}
          <Button variant="secondary" formaction="?/move" name="move" value="{b.id}:down"
            >{t('admin.block.move.down')}</Button
          >
        {/if}
        {#if b.duplicable}
          <Button variant="secondary" formaction="?/duplicate" name="duplicate" value={b.id}
            >{t('admin.block.duplicate')}</Button
          >
        {/if}
        <ConfirmAction
          label={t('admin.block.remove.short')}
          question={fill(t('admin.block.remove.ask'), { n: i + 1 })}
          confirm={t('admin.block.remove.confirm')}
          name="{i + 1}. {t(`admin.block.type.${b.type}` as UiKey)}"
          formaction="?/remove"
          field={{ name: 'remove', value: b.id }}
        />
      {/if}
    {/snippet}
    <BlockFields
      fields={BLOCK_DEFINITIONS[b.type].fields}
      values={blockValues(b)}
      locales={shown}
      idPrefix="b-{b.id}"
      {prefix}
      media={data.media}
      {base}
      upload={data.upload}
      items={data.items}
      invalid={issues.map((x) => x.name)}
      locale={data.locale}
      groups={{ display: shape.display, source: shape.source, labels: groupLabels }}
    />
    {#if data.assistEnabled && b.type === 'image' && b.values[`${prefix}p.decorative`] !== 'on'}
      <p class="ui-hint">
        <a href={assist({ task: 'alt', block: b.id, locale: work })}>{t('admin.assist.alt')}</a>
      </p>
    {/if}
    {#if data.assistEnabled && b.type === 'rich-text' && b.translatable.length}
      <p class="ui-hint">
        {#each b.translatable as source (source)}
          <a
            href={assist({
              task: 'translate',
              from: source,
              to: work,
              target: `blocks.${b.id}.props.content`,
            })}>{fill(t('admin.assist.translateFrom'), { locale: source })}</a
          >
        {/each}
      </p>
    {/if}
  </BlockCard>
{/snippet}

{#snippet inserter(b: (typeof data.blocks)[number])}
  <details class="ui-block-insert">
    <summary><Icon name="plus" />{t('admin.block.insert.fold')}</summary>
    <div class="ui-block-insert-body">
      <Select
        id="insert-type-{b.id}"
        name="insertType.{b.id}"
        label={t('admin.block.insert.type')}
        locale={data.locale}
        options={blockTypeOptions}
      />
      <Button variant="secondary" formaction="?/insert" name="insert" value="before:{b.id}"
        >{t('admin.block.insert.here')}</Button
      >
    </div>
  </details>
{/snippet}

{#snippet startTranslation()}
  <section class="ui-panel" id="translate" aria-labelledby="translate-title">
    <h2 id="translate-title">{fill(t('admin.locale.translate.title'), { locale: work })}</h2>
    <p>{t('admin.locale.translate.body')}</p>
    {#if data.assistEnabled}<p class="ui-hint">{t('admin.locale.translate.assist')}</p>{/if}
    {#if data.canWrite}
      <input type="hidden" name="translateTo" value={work} />
      <Actions>
        {#each sources as source (source)}
          <Button formaction="?/startTranslation" name="from" value={source}
            >{fill(t('admin.locale.translate.copy'), { locale: source })}</Button
          >
        {/each}
        <Button variant="secondary" formaction="?/startTranslation" name="from" value=""
          >{t('admin.locale.translate.empty')}</Button
        >
      </Actions>
    {/if}
  </section>
{/snippet}

{#snippet contentTab()}
  <input type="hidden" name="baseRevisionId" value={baseRevision} />
  <input type="hidden" name="editLocale" value={data.translating ? '' : work} />
  {#if data.translating}
    {@render startTranslation()}
  {:else}
    {@render contentFields()}
  {/if}
{/snippet}

{#snippet contentFields()}
  <div class="ui-field">
    <label class="ui-visually-hidden" for="title.{work}">{t('admin.content.edit.titleLabel')}</label
    >
    <input
      class="ui-title-input"
      size="1"
      id="title.{work}"
      name="title.{work}"
      type="text"
      maxlength="200"
      required={work === defaultLocale}
      value={v(`title.${work}`)}
      lang={work}
    />
  </div>
  {@render translateLinks('title', 'title', work, t('admin.content.field.title'))}
  {@render area(`lead.${work}`, t('admin.content.field.lead'), 1000)}
  {@render translateLinks('lead', 'lead', work, t('admin.content.field.lead'))}
  <MediaPicker
    id="heroImageId"
    name="heroImageId"
    label={t('admin.content.field.heroImage')}
    hint={t('admin.content.field.heroImageHint')}
    locale={data.locale}
    value={v('heroImageId')}
    options={data.media}
    {base}
    upload={data.upload}
  />

  <section aria-labelledby="blocks" class="item-blocks">
    <h3 id="blocks">{t('admin.block.title')}</h3>
    {#if article && data.canWrite}
      <WritingSurface
        content={data.articleEditor}
        name="articleEditor"
        locale={data.locale}
        contentLocale={work}
        media={data.media}
        {base}
        upload={data.upload}
        article
        fallback={earlyProse}
        value={v('articleEditor')}
      />
    {/if}
    {#if data.blocks.length === 0 && !pending}
      <EmptyState title={t('admin.block.empty')} level={3} />
      {#if data.canWrite && data.patterns.length}
        <Select
          id="patternId"
          name="patternId"
          label={t('admin.content.new.pattern')}
          locale={data.locale}
          options={data.patterns.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Button variant="secondary" formaction="?/pattern">{t('admin.content.new.pattern')}</Button>
      {/if}
    {/if}
    {#each data.blocks as b, i (b.id)}
      {#if data.canWrite && !pending}{@render inserter(b)}{/if}
      {#if pending?.place === 'before' && pending.anchor === b.id}{@render pendingCard(
          pending
        )}{/if}
      <fieldset
        data-native-prose={article && b.type === 'rich-text' ? '' : undefined}
        class="native-block"
      >
        <legend class="ui-visually-hidden">{t(`admin.block.type.${b.type}` as UiKey)}</legend>
        {@render blockCard(b, i)}
      </fieldset>
      {#if pending?.place === 'after' && pending.anchor === b.id}{@render pendingCard(pending)}{/if}
    {/each}
    {#if pending?.place === 'end'}{@render pendingCard(pending)}{/if}
    {#if data.canWrite}
      <Fieldset legend={t('admin.block.add')}>
        <Select
          id="insert-type-end"
          name="insertType.end"
          label={t('admin.block.insert.type')}
          locale={data.locale}
          options={blockTypeOptions}
        />
        <Actions>
          <Button variant="secondary" formaction="?/insert" name="insert" value="end"
            >{t('admin.block.add.go')}</Button
          >
        </Actions>
      </Fieldset>
    {/if}
  </section>
{/snippet}

{#snippet inheritedImage(name: string, image: { mediaId: string | null; source: string | null })}
  {#if empty(name)}
    <Inherited
      id="{name}-inherited"
      locale={data.locale}
      kind="image"
      source={image.source}
      thumb={thumbOf(image.mediaId)}
    />
  {/if}
{/snippet}

{#snippet inheritedText(name: string, value: { text: string | null; source: string | null })}
  {#if empty(name)}
    <Inherited
      id="{name}-inherited"
      locale={data.locale}
      kind="text"
      source={value.text ? value.source : null}
      text={value.text}
    />
  {/if}
{/snippet}

{#snippet featuredTab()}
  <MediaPicker
    id="featuredImageId"
    name="featuredImageId"
    label={t('admin.content.field.featuredImage')}
    hint={t('admin.content.field.featuredImageHint')}
    locale={data.locale}
    value={v('featuredImageId')}
    options={data.media}
    {base}
    upload={data.upload}
  />
  {@render inheritedImage('featuredImageId', chain(work).images.featured)}
  {@render text(`featuredTitle.${work}`, t('admin.content.field.featuredTitle'))}
  {@render inheritedText(`featuredTitle.${work}`, chain(work).title)}
  {@render translateLinks(
    'featuredTitle',
    'featured.title',
    work,
    t('admin.content.field.featuredTitle')
  )}
  {@render area(`featuredDescription.${work}`, t('admin.content.field.featuredDescription'), 500)}
  {@render inheritedText(`featuredDescription.${work}`, chain(work).summary)}
  {@render translateLinks(
    'featuredDescription',
    'featured.description',
    work,
    t('admin.content.field.featuredDescription')
  )}
{/snippet}

{#snippet findabilityTab()}
  <Fieldset legend={t('admin.content.edit.seo')} collapsed={folded}>
    {@render text(`seoTitle.${work}`, t('admin.content.field.seoTitle'))}
    {@render translateLinks('seoTitle', 'seo.title', work, t('admin.content.field.seoTitle'))}
    {@render area(`seoDescription.${work}`, t('admin.content.field.seoDescription'), 500)}
    {@render inheritedText(`seoDescription.${work}`, chain(work).seoDescription)}
    {@render translateLinks(
      'seoDescription',
      'seo.description',
      work,
      t('admin.content.field.seoDescription')
    )}
    <Checkbox
      id="noindex"
      name="noindex"
      label={t('admin.content.field.noindex')}
      checked={v('noindex') === 'on'}
    />
    {@render text('canonical', t('admin.content.field.canonical'), { max: 2048 })}
    <MediaPicker
      id="shareImageId"
      name="shareImageId"
      label={t('admin.content.field.shareImage')}
      locale={data.locale}
      value={v('shareImageId')}
      options={data.media}
      {base}
      upload={data.upload}
    />
    {@render inheritedImage('shareImageId', chain(work).images.share)}
  </Fieldset>
{/snippet}

{#snippet settingsTab()}
  {#if data.showAccess}
    <Fieldset legend={t('admin.content.edit.access')} collapsed={folded}>
      <Select
        id="level"
        name="level"
        invalid={flagged('level')}
        label={t('admin.content.field.level')}
        locale={data.locale}
        value={v('level')}
        options={['public', 'members', ...(v('level') === 'tier' ? ['tier'] : [])].map((level) => ({
          value: level,
          label: t(`admin.content.level.${level}` as UiKey),
        }))}
      />
      <Select
        id="teaser"
        name="teaser"
        invalid={flagged('teaser')}
        label={t('admin.content.field.teaser')}
        locale={data.locale}
        value={v('teaser')}
        options={['lead', 'marker', 'blocks'].map((teaser) => ({
          value: teaser,
          label: t(`admin.content.teaser.${teaser}` as UiKey),
        }))}
      />
      <Field
        id="teaserBlocks"
        name="teaserBlocks"
        invalid={flagged('teaserBlocks')}
        type="number"
        label={t('admin.content.field.teaserBlocks')}
        locale={data.locale}
        min="0"
        max="200"
        value={v('teaserBlocks')}
      />
    </Fieldset>
  {/if}
  {#if article}
    <Fieldset legend={t('admin.content.field.corrections')} collapsed={folded}>
      {#each data.corrections as c, i (i)}
        <p>{c.date}: {c.text[work] ?? c.text[defaultLocale] ?? Object.values(c.text)[0]}</p>
      {/each}
      <Field
        id="correctionDate"
        name="correctionDate"
        invalid={flagged('correctionDate')}
        type="date"
        label={t('admin.content.edit.correctionDate')}
        locale={data.locale}
        value={v('correctionDate')}
      />
      {#if !data.translating}
        {@render area(`correctionText.${work}`, t('admin.content.edit.correctionText'), 2000)}
      {/if}
    </Fieldset>
  {/if}
  <Fieldset legend={t('admin.content.new.locales')} collapsed={folded}>
    <Choices
      id="locale"
      name="locales"
      type="checkbox"
      legend={t('admin.content.new.locales')}
      locale={data.locale}
      hint={t('admin.content.edit.localesHint')}
      selected={docLocales}
      invalid={flagged('locales')}
      options={data.locales.map((l) => ({ value: l, label: l }))}
    />
  </Fieldset>
{/snippet}

{#snippet statusCard(p: Publication)}
  {@const state = stateOf(p)}
  <StatusCard
    id="publication-{p.locale}"
    title={t('admin.content.edit.side')}
    state={state.text}
    tone={state.tone}
    level={2}
  >
    {#if data.restricted}
      <Notice tone="warning" live={false}><p>{t('admin.content.publication.restricted')}</p></Notice
      >
    {/if}
    {#if p.pin && p.live}
      <p>
        {fill(
          t(
            p.pin.revision.latest ? 'admin.content.state.pinned' : 'admin.content.state.pinnedOlder'
          ),
          { at: p.pin.at }
        )}
      </p>
    {:else if p.pin && !p.pin.revision.latest}
      <p>{t('admin.content.publication.pinnedOlder')}</p>
    {/if}
    {#if p.issues.length}
      <p>{t('admin.content.publication.issues')}</p>
      {@render issueList(p.issues)}
    {/if}
    {#if data.machineTranslation[p.locale]?.length}
      <Notice tone="warning" live={false}><p>{t('admin.assist.unreviewed')}</p></Notice>
      {#if data.canPublish}
        <div class="translation-approval">
          <Actions stack>
            <Button formaction="?/approveTranslation" name="locale" value={p.locale}
              >{fill(t('admin.assist.approve'), { locale: p.locale })}</Button
            >
          </Actions>
        </div>
      {/if}
    {/if}
    {#if !data.canPublish}
      <p class="ui-hint">{t('admin.content.publication.readOnly')}</p>
    {/if}
    {#snippet actions()}
      {#if data.canPublish && (!p.live || p.changes || (p.pin && !p.pin.revision.latest))}
        <Button formaction="?/publish" name="locale" value={p.locale}
          >{t(
            p.live ? 'admin.content.action.publishChanges' : 'admin.content.action.publish'
          )}</Button
        >
      {/if}
      {#if p.href}
        <Button
          variant={p.live && !p.changes ? 'primary' : 'secondary'}
          href={p.href}
          aria-describedby="new-tab"
          target="_blank">{t('admin.content.action.view')}</Button
        >
      {/if}
      {#if data.canPublish && p.pin && !p.pin.revision.latest}
        <Button variant="secondary" formaction="?/repin" name="locale" value={p.locale}
          >{t('admin.content.action.repin')}</Button
        >
      {/if}
      {#if data.canPublish && p.pin}
        <Button variant="secondary" formaction="?/unschedule" name="locale" value={p.locale}
          >{t('admin.content.action.unschedule')}</Button
        >
      {/if}
      {#if data.canPublish && p.live}
        <Button variant="secondary" formaction="?/unpublish" name="locale" value={p.locale}
          >{t('admin.content.action.unpublish')}</Button
        >
      {/if}
    {/snippet}
    {#snippet more()}
      {#if data.canPublish}
        <details class="ui-fold" open={form && 'locale' in form && form.locale === p.locale}>
          <summary>{t('admin.content.action.scheduleFold')}</summary>
          <Field
            id="at.{p.locale}"
            name="at.{p.locale}"
            type="datetime-local"
            label={t('admin.content.publication.at')}
            locale={data.locale}
            hint={data.timeZoneNamed
              ? `${t('admin.content.publication.zone')} ${data.timeZone}`
              : undefined}
            value={p.pin?.input ?? ''}
          />
          <Actions stack>
            <Button variant="secondary" formaction="?/schedule" name="locale" value={p.locale}
              >{t('admin.content.action.schedule')}</Button
            >
          </Actions>
        </details>
      {/if}
    {/snippet}
  </StatusCard>
{/snippet}

<EditPage
  {title}
  locale={data.locale}
  asideLabel={t('admin.content.edit.side')}
  form={{
    id: 'item-edit',
    method: 'post',
    action: '?/save',
    'data-live-preview-source': '',
  }}
>
  {#snippet bar()}
    {@const state = mainPublication ? stateOf(mainPublication) : null}
    <!-- Enter in a text field submits with the form's first submit button in document order;
         without this one that is the bar's locale switch, which saves and then switches. -->
    <button
      form="item-edit"
      formaction="?/save"
      class="ui-default-submit"
      tabindex="-1"
      aria-hidden="true">{t('admin.content.edit.save')}</button
    >
    <ItemBar
      back={{
        href: `${base}/content?type=${data.item.type}`,
        label: t(article ? 'admin.content.filter.article' : 'admin.content.filter.page'),
      }}
      title={fill(t('admin.content.edit.title'), { type: typeName })}
      state={state?.text ??
        (data.translating ? fill(t('admin.locale.translate.title'), { locale: work }) : undefined)}
      stateHref={mainPublication ? `#publication-${mainPublication.locale}` : undefined}
      tone={state?.tone}
      save={data.canWrite
        ? {
            text: form
              ? t('admin.content.save.refused')
              : data.saved
                ? t('admin.content.save.saved')
                : '',
            unsaved: t('admin.content.save.unsaved'),
            saving: t('admin.content.save.saving'),
            refused: !!form,
          }
        : undefined}
    >
      {#snippet locales()}
        {#if multi}
          <LocaleSwitch
            label={t('admin.locale.switch')}
            locale={data.locale}
            form="item-edit"
            formaction="?/switchLocale"
            locales={data.translations.map((x) => ({ ...x, current: x.locale === work }))}
          />
        {/if}
      {/snippet}
      {#snippet actions()}
        {#if livePreview}
          <button
            type="button"
            class="ui-button secondary ui-preview-toggle"
            data-preview-toggle
            aria-pressed="false"
            aria-controls="live-preview"
            ><span class="ui-preview-toggle-off"><Icon name="eye" /></span><span
              class="ui-preview-toggle-on"><Icon name="eye-off" /></span
            >{t('admin.content.edit.previewShort')}</button
          >
        {/if}
        {#if !data.translating}
          <Button
            variant="secondary"
            class="ui-preview-link"
            href={previewHref(work)}
            target="_blank"
            aria-describedby="new-tab"
            data-preview-link={work}>{t('admin.content.edit.previewShort')}</Button
          >
        {/if}
        <Button form="item-edit" formaction="?/save">{t('admin.content.edit.save')}</Button>
      {/snippet}
    </ItemBar>
  {/snippet}

  {#snippet notices()}
    {#if form && !form.conflict}
      <Notice tone="error" title={t('error.summary.title')}>
        {#if issues.length}
          <p>{t(form.error as UiKey)}</p>
          <ul>
            {#each issues as i (i.name + i.copy)}
              <li>
                {#if i.name}<a href="#{fieldId(i.name)}">{fieldLabel(i.name)}</a>:
                {/if}{t(i.copy as UiKey)}
              </li>
            {/each}
          </ul>
        {:else if 'issues' in form && form.issues?.length}
          <p>
            {fill(t('admin.content.publication.error.refused'), { locale: form.locale ?? '' })}
          </p>
          {@render issueList(form.issues ?? [])}
        {:else}
          <p>{t(form.error as UiKey)}</p>
        {/if}
      </Notice>
    {/if}
    {#if form?.conflict}
      <Notice tone="error" title={t('admin.content.conflict.title')}>
        <p>
          {fill(t('admin.content.conflict.body'), {
            who: form.conflict.who,
            when: form.conflict.when,
          })}
        </p>
        <Diff rows={form.conflict.changes} locale={data.locale} />
      </Notice>
    {/if}
    {#if data.done}
      <Notice tone="success"><p>{fill(t(data.done), { locale: data.doneLocale })}</p></Notice>
    {:else if data.saved && !form}
      <Notice tone="success"><p>{t('admin.content.done.saved')}</p></Notice>
    {/if}
  {/snippet}

  <p id="new-tab" class="ui-visually-hidden">{t('admin.content.edit.newTab')}</p>
  <Tabs
    id="item-tabs"
    label={t('admin.content.tab.label')}
    tabs={[
      { id: 'content', label: t('admin.content.tab.content'), content: contentTab },
      { id: 'featured', label: t('admin.content.tab.featured'), content: featuredTab },
      { id: 'findability', label: t('admin.content.tab.findability'), content: findabilityTab },
      { id: 'settings', label: t('admin.content.tab.settings'), content: settingsTab },
    ]}
  />

  {#snippet preview()}
    {#if livePreview}
      <section
        id="live-preview"
        class="ui-section live-preview ui-edit-preview"
        data-live-preview
        data-item-id={data.item.id}
        data-preview-action="{base}/preview/draft"
        hidden
        aria-labelledby="live-preview-title"
      >
        <h2 id="live-preview-title">{t('admin.content.preview.live')}</h2>
        <input type="hidden" value={work} data-live-preview-locale />
        <iframe
          name="mycel-live-preview"
          title={t('admin.content.preview.live')}
          data-live-preview-frame
        ></iframe>
        <p class="ui-hint">{t('admin.content.preview.keyboard')}</p>
        <p class="ui-hint">
          <a href={previewHref(work)} target="_blank" aria-describedby="new-tab"
            >{t('admin.content.preview.saved')}</a
          >
        </p>
      </section>
    {/if}
  {/snippet}

  {#snippet aside()}
    {#if mainPublication}{@render statusCard(mainPublication)}{/if}
    {#if multi && others.length}
      <section aria-labelledby="other-locales" class="item-locales">
        <h2 id="other-locales">{t('admin.content.item.locales')}</h2>
        <ul>
          {#each others as o (o.locale)}
            <li>
              <Button variant="link" formaction="?/switchLocale" name="to" value={o.locale}
                >{o.locale}</Button
              >
              {#if o.publication}<span>{stateOf(o.publication).text}</span>{/if}
              {#if o.state !== 'ok'}<span class="ui-hint">{stateWords(o.state)}</span>{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section aria-labelledby="this-item">
      <h2 id="this-item">{t('admin.content.item.title')}</h2>
      <MetaList items={[{ term: t('admin.content.item.url'), value: `/${data.item.slug}` }]} />
      {#if article}
        <div id="authors">
          <Choices
            id="author"
            name="authorIds"
            type="checkbox"
            legend={t('admin.content.field.authors')}
            locale={data.locale}
            hint={authors.length === 0 ? t('admin.content.edit.noAuthors') : undefined}
            selected={list('authorIds')}
            options={authors.map((a) => ({ value: a.id, label: a.name }))}
          />
        </div>
        <Select
          id="sectionId"
          name="sectionId"
          label={t('admin.content.field.section')}
          locale={data.locale}
          value={v('sectionId')}
          options={[
            { value: '', label: t('admin.content.edit.noSection') },
            ...sections.map((s) => ({ value: s.id, label: s.title })),
          ]}
        />
        {@render text('tags', t('admin.content.field.tags'), { max: 2000 })}
      {/if}
      <p>
        <a href="{base}/content/{data.item.id}/revisions">{t('admin.content.revisions')}</a>
      </p>
    </section>
  {/snippet}
</EditPage>

<style>
  .native-block {
    border: 0;
    padding: 0;
    margin: 0;
    min-inline-size: 0;
  }
  .native-block[hidden] {
    display: none;
  }
</style>
