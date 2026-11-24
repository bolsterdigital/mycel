<!-- One lossless form serves native block editing and the enhanced article writing sheet.
     Fragments preserve values; publication and locale/conflict checks remain server-owned.
     Rejected: a second SPA form with independent save rules. -->
<script lang="ts">
  import ArticleBlocks from '#lib/editor/article/ArticleBlocks.svelte';
  import AuthorPicker from '#lib/admin/people/AuthorPicker.svelte';
  import OldAddresses from '#lib/admin/old-addresses/OldAddresses.svelte';
  import ItemPanels from '#lib/admin/email-preview/ItemPanels.svelte';
  import EditorShortcuts from '#lib/editor/EditorShortcuts.svelte';
  import { onMount } from 'svelte';
  import { earlyInput } from '#lib/editor/early-input.js';
  import { editorFieldIssues, typedOver } from '#lib/editor/block-form.js';
  import PublicationDrawer from '#lib/admin/ui/feedback/PublicationDrawer.svelte';
  import WritingSurface from '#lib/editor/WritingSurface.svelte';
  import ItemTitleField from '#lib/editor/ItemTitleField.svelte';
  import { languageName } from '#lib/admin/format.js';
  import BlockFields from '#lib/admin/block-fields/BlockFields.svelte';
  import HeaderImageFields from '#lib/admin/header-fields/HeaderImageFields.svelte';
  import ImagePlacementFields from '#lib/admin/header-fields/ImagePlacementFields.svelte';
  import HeroConversion from '#lib/admin/hero-conversion/HeroConversion.svelte';
  import EventFields from '#lib/admin/event-fields/EventFields.svelte';
  import HeaderFields from '#lib/admin/header-fields/HeaderFields.svelte';
  import PrefooterSwitch from '#lib/admin/prefooter-switch/PrefooterSwitch.svelte';
  import DossierFields from '#lib/admin/dossier-fields/DossierFields.svelte';
  import SlugField from '#lib/admin/slug-field/SlugField.svelte';
  import ItemLocales from '#lib/admin/item-locales/ItemLocales.svelte';
  import BlockDrop from '#lib/admin/block-drop/BlockDrop.svelte';
  import PendingBlock from '#lib/admin/pending-block/PendingBlock.svelte';
  import ReviewOffer from '#lib/admin/review-offer/ReviewOffer.svelte';
  import ConflictNotice from '#lib/admin/conflict/ConflictNotice.svelte';
  import MergeNotice from '#lib/admin/conflict/MergeNotice.svelte';
  import EditPresence from '#lib/admin/presence/EditPresence.svelte';
  import Inherited from '#lib/admin/Inherited.svelte';
  import IssueList from '#lib/admin/issues/IssueList.svelte';
  import PatternChoice, { offers } from '#lib/admin/patterns/PatternChoice.svelte';
  import SavePattern from '#lib/admin/patterns/SavePattern.svelte';
  import AccessFields from '#lib/admin/access/AccessFields.svelte';
  import { issueLabel } from '#lib/admin/issue-label.js';
  import { thumbPath } from '#lib/admin/ui/thumb.js';
  import {
    Actions,
    Badge,
    BlockCard,
    BlockImage,
    BlockInserter,
    BlockSummary,
    BlockText,
    Button,
    Checkbox,
    DocumentOutline,
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
  import BlockMoveStatus from '#lib/admin/block-move/BlockMoveStatus.svelte';
  import { blockCardLabels, blockGroupLabels } from '#lib/admin/block-move/labels.js';
  import BlockNameField from '#lib/admin/block-fields/BlockNameField.svelte';
  import { DOC_FIELDS, fieldAnchor, WRITER_FIELD } from '#lib/admin/issue-label.js';
  import { BLOCK_ICONS, BLOCK_PRESENTATION } from '#lib/admin/block-presentation.js';
  import { blockNotice, restWords } from '#lib/admin/block-rest-words.js';
  import { pickAny, BLOCK_DEFINITIONS, pick, type BlockType, type MediaCredit } from '@mycel/core';
  import { creditText, creditWords } from '#lib/blocks/credit.js';
  import { fill, ui, type UiKey, refusalCopy } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  onMount(() => {
    // These modules change disclosure state; start them after hydration has claimed the form.
    for (const src of [
      '/_admin/tabs.js',
      ...(data.canWrite
        ? [
            '/_admin/edit-screen.js',
            '/_admin/session-restore.js',
            '/_admin/block-move.js',
            '/_admin/image-placement.js',
          ]
        : []),
      ...(data.canWrite && data.upload ? ['/_admin/block-drop.js'] : []),
      ...(!data.translating && data.item.type === 'page' && data.canWrite
        ? ['/_admin/live-preview-parent.js']
        : []),
    ]) {
      // Not a script element: its `src` takes a Trusted Type, and these are fixed addresses.
      void import(/* @vite-ignore */ src);
    }
  });
  const early = earlyInput('item-edit');
  const earlyProse =
    early.$nativeArticle === 'open' ||
    Object.keys(early).some((name) =>
      data.blocks.some((b) => b.type === 'rich-text' && name.startsWith(`b.${b.id}.`))
    );
  const posted = $derived(form && 'values' in form ? form.values : null);
  /** Input kept through a login (`recover`, session-restore.js), or a row rearranged (`arrange`). */
  const recovered = $derived(!!(form && 'recovered' in form && form.recovered));
  /** Discarding it is opening the item again, in the locale the screen shows. */
  const discardHref = $derived(
    `/admin/${data.tenant.slug}/content/${data.item.id}?${new URLSearchParams({ locale: data.workLocale })}`
  );
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
  const dossiers = $derived((form && 'dossiers' in form ? form.dossiers : null) ?? data.dossiers);
  const pending = $derived(form && 'pending' in form ? form.pending : data.pending);
  const issues = $derived<{ name: string; list?: string; copy: string }[]>(
    editorFieldIssues(form, data.blocks)
  );
  const docLocales = $derived(list('locales'));
  /** The one locale the screen shows (#66 PR 4); its fields only, while the item has it. */
  const work = $derived(data.workLocale);
  // A named action replaces the query. Carry the displayed locale on every post so a refusal
  // reloads the same language, even for a direct link without a remembered locale choice.
  // Rejected: changing the cookie on a view-only link or fixing only the Save button.
  const action = (name: string) => `?/${name}&locale=${encodeURIComponent(work)}`;
  const shown = $derived(data.translating ? [] : [work]);
  /** The site has more than one locale: the switch shows (table stake 13). */
  const multi = $derived(data.translations.length > 1);
  const base = $derived(`/admin/${data.tenant.slug}`);
  const article = $derived(data.item.type === 'article');
  const listed = $derived(article ? 'article' : (data.contentProfile ?? 'page'));
  /**
   * From this many blocks a page gets its compact table of contents (#66 PR 6d): about two
   * screens of closed cards. An article with JavaScript is one running editor, not cards.
   */
  const OUTLINE_FROM = 8;
  const outline = $derived(
    !article && data.blocks.length >= OUTLINE_FROM
      ? data.blocks.map((b) => ({
          href: `#block-${b.id}`,
          kind: t(`admin.block.type.${b.type}` as const),
          text: b.preview.text || b.preview.entries[0] || '',
        }))
      : []
  );
  const defaultLocale = $derived(data.item.defaultLocale);
  const title = $derived(
    (data.values[`title.${work}`] as string | undefined) ||
      (data.values[`title.${defaultLocale}`] as string | undefined) ||
      t('admin.content.untitled')
  );
  const typeName = $derived(t(`admin.content.type.${data.item.type}` as const));
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
  /** A writer who cannot publish may offer what is not yet live or planned. */
  const offerable = (p: Publication): boolean =>
    data.canWrite &&
    !data.canPublish &&
    !p.review &&
    (!p.live || p.changes) &&
    !p.pin?.revision.latest;
  const compactStateOf = (p: Publication): string =>
    p.live
      ? t(p.changes ? 'admin.content.state.short.changed' : 'admin.content.state.short.live')
      : p.pin
        ? t('admin.content.state.short.pinned')
        : t(
            p.status === 'unpublished' ? 'admin.content.state.offline' : 'admin.content.state.draft'
          );

  /** A stored value: a refused post carries only the locale on screen. */
  const saved = (k: string): string => {
    const x = data.values[k];
    return typeof x === 'string' ? x : '';
  };
  /** Whether a refused save named this field. */
  const flagged = (name: string) => issues.some((i) => i.name === name);
  /** A refused save, or a refused publish, which names its issues with a link instead (#158). */
  const heroAltRefused = $derived(
    flagged('heroAlt') ||
      !!(form && 'issues' in form && form.issues?.some((i) => i.field === 'heroAlt'))
  );
  /** A field name as words: a document field's label, a block field's plus its locale, a list's. */
  const fieldLabel = (name: string, list = false): string => {
    if (name in DOC_FIELDS) return t(DOC_FIELDS[name]!);
    const parts = name
      .replace(/^(b\.[^.]+|new)\./, '')
      .split('.')
      .slice(1);
    const locale = data.docLocales.includes(parts.at(-1) ?? '') ? parts.pop() : null;
    const key = [...parts].reverse().find((p) => !/^\d+$/.test(p) && p !== 'mode');
    const label = key
      ? t(`admin.block.${list ? 'list' : 'field'}.${key}` as UiKey)
      : t('admin.block.title');
    return locale ? `${label} (${locale})` : label;
  };
  const fieldId = (name: string) => fieldAnchor(name, defaultLocale);
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
  const blockValues = (b: (typeof data.blocks)[number]) =>
    typedOver(b.values, { ...posted, ...early }, `b.${b.id}.`);
  /** The chain of one locale (#86); images are the same in every locale. */
  const chain = (l: string) => data.effective[l] ?? data.effective[defaultLocale]!;
  /** Whether a field is empty both as typed and as stored, so what it inherits applies. */
  const empty = (name: string) => !v(name).trim() && !data.values[name];
  const thumbOf = (id: string | null) =>
    id && data.media.some((m) => m.id === id && m.thumb) ? thumbPath(base, id) : null;
  const cardLabels = $derived(blockCardLabels(t));
  const groupLabels = $derived(blockGroupLabels(t));
  /** A credit as the page words it (`lib/blocks/Credit.svelte`), in the content locale. */
  const creditLine = (c: MediaCredit): string => creditText(c, creditWords(ui(work)));
  /** What every insertion point offers: the block types, then the site's patterns (ADR 013.4). */
  const picker = $derived({
    locale: data.locale,
    action: `?/insert&locale=${work}`,
    options: data.blockTypes.map((type) => ({
      value: type,
      label: t(`admin.block.type.${type}` as const),
      icon: BLOCK_ICONS[type],
    })),
    patterns: (data.patterns?.own ?? []).map((p) => ({ value: `pattern:${p.id}`, label: p.name })),
  });
</script>

<svelte:head>
  <title
    >{form ? `${t('error.prefix')} ` : ''}{title} · {data.tenant.name} · {t('admin.title')}</title
  >
</svelte:head>

{#snippet translateLinks(field: string, target: string, locale: string, label: string)}
  {#if data.assistEnabled}
    {@const sources = docLocales.filter((s: string) => s !== locale && !!v(`${field}.${s}`))}
    {@const own = data.ownAssist[target]}
    {#if sources.length || own}
      <p class="ui-hint">
        {#each sources as source (source)}
          <a href={assist({ task: 'translate', from: source, to: locale, target })}>
            {fill(t('admin.assist.translateFrom'), { locale: source })}
            {label} ({locale})
          </a>
        {/each}
        {#if own}<a href={assist({ task: own, locale })}>{t(`admin.assist.${own}`)}</a>{/if}
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

{#snippet pendingCard(p: NonNullable<typeof pending>)}
  <PendingBlock
    pending={p}
    values={Object.fromEntries(
      Object.entries(early).filter((e): e is [string, string] => typeof e[1] === 'string')
    )}
    locales={shown}
    media={data.media}
    {base}
    upload={data.upload}
    references={data}
    invalid={issues.map((x) => x.name)}
    locale={data.locale}
    {action}
  />
{/snippet}

{#snippet articlePreview(native = false)}
  <ArticleBlocks
    blocks={data.blocks}
    document={data.articleEditor}
    card={blockCard}
    {inserter}
    label={(type) => t(`admin.block.type.${type}`)}
    inserting={!pending}
    {native}
  />
{/snippet}

{#snippet nativeProse()}{@render articlePreview(true)}{/snippet}

{#snippet blockRest(b: (typeof data.blocks)[number])}
  {#snippet picture(img: NonNullable<typeof b.image>, field: string)}
    {@const prefix = `b.${b.id}.p.${b.type === 'hero' ? 'image.' : ''}`}
    {@const values = blockValues(b)}
    <BlockImage
      src={img.card ? `${base}/media/${img.mediaId}/variant/${img.card.file}` : null}
      width={img.card?.width ?? 4}
      height={img.card?.height ?? 3}
      caption={img.caption}
      captionSource={img.captionSource}
      credit={img.credit ? creditLine(img.credit) : null}
      missing={fill(t('admin.block.image.missing'), { file: img.label })}
      replace={{ href: `#b-${b.id}-p-${field}`, label: t('admin.block.image.replace') }}
      thumbSrc={thumbPath(base, img.mediaId)}
      previewLabel={t('admin.block.image.preview')}
      alt={{
        text: values[`${prefix}alt.${work}`] ?? '',
        decorative: values[`${prefix}decorative`] === 'on',
        from: `${prefix}alt.${work}`,
        decorativeFrom: `${prefix}decorative`,
        label: t('admin.block.field.alt'),
        decorativeLabel: t('admin.block.image.decorative'),
        missingLabel: t('admin.block.image.altMissing'),
      }}
    />
  {/snippet}
  {#if BLOCK_PRESENTATION[b.type].rest === 'image' && b.image}
    {@render picture(b.image, 'mediaId')}
  {:else if BLOCK_PRESENTATION[b.type].rest === 'text' && b.text}
    {#if b.type === 'hero' && b.image}{@render picture(b.image, 'image-mediaId')}{/if}
    {@const words = restWords(b.text, data.restricted, t, data.locale)}
    <BlockText view={b.text} {...words} />
    {#if b.type === 'hero'}
      <p class="ui-hint">
        {t('admin.block.hero.legacy')}
        {#if data.heroConversion?.heroId === b.id}
          <a href="#hero-conversion">{t('admin.block.hero.move')}</a>
        {/if}
      </p>
    {/if}
  {:else}
    {@const image = b.preview.mediaId
      ? data.media.find((m) => m.id === b.preview.mediaId && m.thumb)
      : undefined}
    <BlockSummary
      text={b.preview.text}
      thumb={image ? thumbPath(base, image.id) : null}
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
    id={article && b.type === 'rich-text' ? `native-block-${b.id}` : `block-${b.id}`}
    class="block"
    number={i + 1}
    type={t(`admin.block.type.${b.type}` as const)}
    icon={BLOCK_ICONS[b.type]}
    name={b.naming.name}
    nameIfEmpty={b.type === 'image' ? b.image?.label : ''}
    nameLang={work}
    notice={blockNotice(
      { id: b.id, refused },
      data.item.publication,
      { work, locale: data.locale },
      t
    )}
    editable={BLOCK_DEFINITIONS[b.type].fields.length > 0}
    open={refused ||
      !!(form && 'arranged' in form && String(form.arranged).startsWith(prefix)) ||
      data.openBlocks.includes(b.id) ||
      (Array.isArray(early.$openBlocks) && early.$openBlocks.includes(b.id))}
    labels={cardLabels}
    moveLabel={data.canWrite && !pending && data.blocks.length > 1
      ? t('admin.block.move.grip')
      : undefined}
  >
    {#snippet nameField()}
      <BlockNameField block={b} values={blockValues(b)} {work} {t} editable={data.canWrite} />
    {/snippet}
    {#snippet rest()}{@render blockRest(b)}{/snippet}
    {#snippet actions()}
      {#if data.canWrite}
        {#if !pending}
          <a
            class="ui-block-card-action"
            href={data.blocks[i + 1] ? `#insert-${data.blocks[i + 1]!.id}-body` : '#insert-end'}
            data-insert-below="insert-{data.blocks[i + 1]?.id ?? 'end'}"
            ><Icon name="plus" />{t('admin.block.card.insertBelow')}</a
          >
        {/if}
        {#if i > 0}
          <button
            class="ui-block-card-action"
            type="submit"
            formaction={action('move')}
            name="move"
            value="{b.id}:up"><Icon name="arrow-up" />{t('admin.block.move.up')}</button
          >
        {/if}
        {#if i < data.blocks.length - 1}
          <button
            class="ui-block-card-action"
            type="submit"
            formaction={action('move')}
            name="move"
            value="{b.id}:down"><Icon name="arrow-down" />{t('admin.block.move.down')}</button
          >
        {/if}
        {#if b.duplicable}
          <button
            class="ui-block-card-action"
            type="submit"
            formaction={action('duplicate')}
            name="duplicate"
            value={b.id}><Icon name="copy" />{t('admin.block.duplicate')}</button
          >
        {/if}
        <!-- No confirmation: the notice after it offers "Undo" (#66 PR 6c). -->
        <button
          class="ui-block-card-action danger"
          type="submit"
          formaction={action('remove')}
          name="remove"
          value={b.id}><Icon name="trash-2" />{t('admin.block.remove.short')}</button
        >
      {/if}
    {/snippet}
    <BlockFields
      block={b}
      values={blockValues(b)}
      locales={shown}
      idPrefix="b-{b.id}"
      {prefix}
      media={data.media}
      {base}
      upload={data.upload}
      references={data}
      invalid={issues.map((x) => x.name)}
      locale={data.locale}
      groups={{ display: shape.display, source: shape.source, labels: groupLabels }}
      row={shape.row}
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

{#snippet inserter(b: (typeof data.blocks)[number], i: number)}
  <details class="ui-block-insert" id="insert-{b.id}">
    <summary><Icon name="plus" />{t('admin.block.insert.fold')}</summary>
    <!-- The link's target: a fragment opens the details around it, not the details it names. -->
    <div class="ui-block-insert-body" id="insert-{b.id}-body">
      <BlockInserter
        id={b.id}
        place="before:{b.id}"
        label={fill(t('admin.block.insert.location.before'), { n: String(i + 1) })}
        {...picker}
      />
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
          <Button formaction={action('startTranslation')} name="from" value={source}
            >{fill(t('admin.locale.translate.copy'), { locale: source })}</Button
          >
        {/each}
        <Button variant="secondary" formaction={action('startTranslation')} name="from" value=""
          >{t('admin.locale.translate.empty')}</Button
        >
      </Actions>
    {/if}
  </section>
{/snippet}

{#snippet contentTab()}
  <input type="hidden" name="baseRevisionId" value={baseRevision} />
  <BlockMoveStatus {t} />
  <!-- Filled by the screen's script on submit: the card in view, so a save stays there. -->
  <input type="hidden" name="nearBlock" value="" />
  <input type="hidden" name="editLocale" value={data.translating ? '' : work} />
  {#if data.translating}
    {@render startTranslation()}
  {:else}
    {@render contentFields()}
  {/if}
{/snippet}

{#snippet contentFields()}
  <!-- MY-110 B3 (ADR 025): title, lead and main image are one header, in the order the page
       shows them; the blocks follow as their own section. The heading is for the outline only:
       the big title field already says where the header starts. -->
  <section aria-labelledby="item-header" class="item-header">
    <h3 id="item-header" class="ui-visually-hidden">{t('admin.content.header.title')}</h3>
    <ItemTitleField
      locale={work}
      label={t('admin.content.edit.titleLabel')}
      value={v(`title.${work}`)}
      required={work === defaultLocale}
    />
    {@render translateLinks('title', 'title', work, t('admin.content.field.title'))}
    {@render area(`lead.${work}`, t('admin.content.field.lead'), 1000)}
    {@render translateLinks('lead', 'lead', work, t('admin.content.field.lead'))}
    {#if data.contentProfile === 'event'}
      <EventFields locale={data.locale} {work} zone={data.siteTimeZone} {v} />
    {/if}
    <HeaderImageFields
      {base}
      locale={data.locale}
      {work}
      {docLocales}
      {v}
      {saved}
      media={data.media}
      upload={data.upload}
      {heroAltRefused}
    />
    {#if data.heroConversion}
      <div id="hero-conversion">
        <HeroConversion
          c={data.heroConversion}
          locale={data.locale}
          {work}
          {defaultLocale}
          formaction={action('convertHero')}
        />
      </div>
    {/if}
  </section>

  <section aria-labelledby="blocks" class="item-blocks">
    <h3 id="blocks">{t('admin.block.title')}</h3>
    {#if article && data.canWrite}
      <WritingSurface
        content={data.articleEditor}
        name={WRITER_FIELD}
        locale={data.locale}
        contentLocale={work}
        media={data.media}
        {base}
        upload={data.upload}
        splitProse={docLocales.length <= 1}
        article
        fallback={earlyProse}
        value={v('articleEditor')}
        preview={articlePreview}
        native={nativeProse}
      />
      {#if pending && pending.place !== 'end'}{@render pendingCard(pending)}{/if}
    {/if}
    {#if data.blocks.length === 0 && !pending}
      <EmptyState title={t('admin.block.empty')} level={3} />
      {#if data.canWrite && offers(data.patterns)}
        <PatternChoice id="patternId" locale={data.locale} choices={data.patterns} />
        <Button variant="secondary" formaction={action('pattern')}
          >{t('admin.content.new.pattern')}</Button
        >
      {/if}
    {/if}
    {#if outline.length}
      <DocumentOutline
        label={t('admin.content.outline.title')}
        count={fill(t('admin.content.outline.count'), { count: String(outline.length) })}
        entries={outline}
      />
    {/if}
    <!-- Optional card commands keep their initial geometry; scripts enable them. -->
    {#if data.blocks.some((b) => !(article && data.canWrite && b.type === 'rich-text'))}
      <div class="ui-block-card-bar" data-block-bar>
        <button type="button" data-block-all="collapse" disabled
          ><Icon name="chevron-up" />{t('admin.block.card.collapseAll')}</button
        >
        <button type="button" data-block-all="expand" disabled
          ><Icon name="chevron-down" />{t('admin.block.card.expandAll')}</button
        >
      </div>
    {/if}
    {#if !(article && data.canWrite)}
      {#each data.blocks as b, i (b.id)}
        {#if data.canWrite && !pending}{@render inserter(b, i)}{/if}
        {#if pending?.place === 'before' && pending.anchor === b.id}{@render pendingCard(
            pending
          )}{/if}
        <fieldset
          data-native-prose={article && b.type === 'rich-text' ? '' : undefined}
          class="native-block"
        >
          <legend class="ui-visually-hidden">{t(`admin.block.type.${b.type}` as const)}</legend>
          {@render blockCard(b, i)}
        </fieldset>
        {#if pending?.place === 'after' && pending.anchor === b.id}{@render pendingCard(
            pending
          )}{/if}
      {/each}
    {/if}
    {#if pending?.place === 'end'}{@render pendingCard(pending)}{/if}
    {#if data.canWrite && data.upload}
      <BlockDrop {base} locale={data.locale} {work} {article} />
    {/if}
    {#if data.canWrite}
      <div id="insert-end">
        <Fieldset legend={t('admin.block.add')}>
          <BlockInserter id="end" place="end" label={t('admin.block.insert.end')} {...picker} />
        </Fieldset>
        <SavePattern blocks={data.blocks} locale={data.locale} {action} failed={form?.error} />
      </div>
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
  {@const photo = data.media.find(
    (m) =>
      m.id === (v('featuredImageId') || v('heroImageId') || chain(work).images.featured.mediaId)
  )}
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
  {#if photo}
    <ImagePlacementFields
      name="featuredPlacement"
      picker="featuredImageId"
      media={photo}
      {base}
      locale={data.locale}
      layout="overview"
      read={v}
      fallback={chain(work).images.featured.source === 'site'
        ? (chain(work).images.featured.mediaId ?? '')
        : ''}
    />
  {/if}
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
    {@render text(`shareImageAlt.${work}`, t('admin.content.field.shareImageAlt'))}
  </Fieldset>
{/snippet}

{#snippet settingsTab()}
  <AccessFields
    locale={data.locale}
    level={v('level')}
    teaser={v('teaser')}
    teaserBlocks={v('teaserBlocks')}
    tierIds={list('tierIds')}
    tiers={data.tiers}
    {flagged}
    collapsed={folded}
    manage={data.canPublish ? `${base}/access` : undefined}
  />
  {#if article}
    <Fieldset legend={t('admin.content.field.corrections')} collapsed={folded}>
      {#each data.corrections as c, i (i)}
        <p>{c.date}: {pickAny(c.text, work, defaultLocale)}</p>
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
  {#if data.contentProfile !== 'zone'}
    <PrefooterSwitch locale={data.locale} checked={v('noPrefooter') === 'on'} collapsed={folded} />
  {/if}
  <ItemLocales
    locale={data.locale}
    locales={data.locales}
    selected={docLocales}
    invalid={flagged('locales')}
    collapsed={folded}
  />
{/snippet}

{#snippet statusCard(p: Publication)}
  {@const state = stateOf(p)}
  <StatusCard
    id="publication-{p.locale}"
    title={languageName(p.locale)}
    variant="panel"
    state={state.text}
    tone={state.tone}
    level={3}
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
      <IssueList list={p.issues} name={issueName} locale={data.locale} />
    {/if}
    {#if p.warnings.length}
      <Notice tone="warning" live={false}>
        <p>{t('admin.content.publication.warnings')}</p>
        <IssueList list={p.warnings} name={issueName} locale={data.locale} />
      </Notice>
    {/if}
    {#if data.machineTranslation[p.locale]?.length}
      <Notice tone="warning" live={false}><p>{t('admin.assist.unreviewed')}</p></Notice>
      {#if data.canPublish}
        <div class="translation-approval">
          <Actions stack>
            <Button formaction={action('approveTranslation')} name="locale" value={p.locale}
              >{fill(t('admin.assist.approve'), { locale: p.locale })}</Button
            >
          </Actions>
        </div>
      {/if}
    {/if}
    {#if !data.canPublish && !offerable(p)}
      <p class="ui-hint">{t('admin.content.publication.readOnly')}</p>
    {/if}
    <ReviewOffer
      locale={data.locale}
      target={p.locale}
      review={p.review}
      offerable={offerable(p)}
    />
    {#snippet actions()}
      {#if data.canPublish && (!p.live || p.changes || (p.pin && !p.pin.revision.latest))}
        <Button formaction={action('publish')} name="locale" value={p.locale}
          >{t(
            p.live ? 'admin.content.action.publishChanges' : 'admin.content.action.publish'
          )}</Button
        >
      {/if}
      {#if p.href}
        <Button variant="link" href={p.href} aria-describedby="new-tab" target="_blank"
          ><Icon name="external-link" />{t('admin.content.action.view')}</Button
        >
      {/if}
      {#if data.canPublish && p.pin && !p.pin.revision.latest}
        <Button variant="secondary" formaction={action('repin')} name="locale" value={p.locale}
          >{t('admin.content.action.repin')}</Button
        >
      {/if}
      {#if data.canPublish && p.pin}
        <Button variant="secondary" formaction={action('unschedule')} name="locale" value={p.locale}
          >{t('admin.content.action.unschedule')}</Button
        >
      {/if}
      {#if offerable(p)}
        <Button formaction={action('offer')} name="locale" value={p.locale}
          >{t('admin.content.review.offer')}</Button
        >
      {/if}
      {#if data.canWrite && p.review}
        <Button
          variant="secondary"
          formaction={action('withdrawOffer')}
          name="locale"
          value={p.locale}>{t('admin.content.review.withdraw')}</Button
        >
      {/if}
    {/snippet}
    {#snippet more()}
      {#if data.canPublish}
        <details
          class="ui-fold ui-publication-option"
          open={form && 'locale' in form && form.locale === p.locale}
        >
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
            <Button
              variant="secondary"
              formaction={action('schedule')}
              name="locale"
              value={p.locale}>{t('admin.content.action.schedule')}</Button
            >
          </Actions>
        </details>
      {/if}
      {#if data.canPublish && p.live}
        <details class="ui-fold ui-publication-option">
          <summary>{t('admin.content.action.unpublish')}</summary>
          <p class="ui-hint">{t('admin.content.publication.offlineHint')}</p>
          <Button
            variant="secondary"
            formaction={action('unpublish')}
            name="locale"
            value={p.locale}>{t('admin.content.action.unpublish')}</Button
          >
        </details>
      {/if}
    {/snippet}
  </StatusCard>
{/snippet}

{#snippet refusalNotice()}
  {#if form && !form.conflict && !recovered}
    <Notice tone="error" title={t('error.summary.title')}>
      {#if issues.length}
        <p>{refusalCopy(t, form)}</p>
        <ul>
          {#each issues as i (i.name + i.copy)}
            <li>
              {#if i.name}<a href="#{fieldId(i.name)}">{fieldLabel(i.list ?? i.name, !!i.list)}</a
                >:{' '}
              {/if}{t(i.copy as UiKey)}
            </li>
          {/each}
        </ul>
      {:else if 'issues' in form && form.issues?.length}
        <p>
          {fill(t('admin.content.publication.error.refused'), { locale: form.locale ?? '' })}
        </p>
        <IssueList list={form.issues ?? []} name={issueName} locale={data.locale} />
      {:else}
        <p>{refusalCopy(t, form)}</p>
      {/if}
    </Notice>
  {/if}
{/snippet}

<EditPage
  {title}
  locale={data.locale}
  asideLabel={t('admin.content.edit.side')}
  form={{
    id: 'item-edit',
    method: 'post',
    action: action('save'),
    'data-live-preview-source': '',
    'data-restore': data.restore ?? undefined,
    'data-restore-operator': data.operatorId ?? undefined,
  }}
>
  {#snippet bar()}
    {@const state = mainPublication ? stateOf(mainPublication) : null}
    <!-- Enter in a text field submits with the form's first submit button in document order;
         without this one that is the bar's locale switch, which saves and then switches. -->
    <button
      form="item-edit"
      formaction={action('save')}
      class="ui-default-submit"
      tabindex="-1"
      aria-hidden="true">{t('admin.content.edit.save')}</button
    >
    <ItemBar
      compact
      locale={data.locale}
      back={{
        href: data.listPath,
        label: t(`admin.content.filter.${listed}`),
      }}
      title={fill(t('admin.content.edit.title'), { type: typeName })}
      state={mainPublication
        ? compactStateOf(mainPublication)
        : data.translating
          ? fill(t('admin.locale.translate.title'), { locale: work })
          : undefined}
      stateDetail={state?.text}
      tone={state?.tone}
      save={data.canWrite
        ? {
            text: recovered
              ? t('admin.content.save.unsaved')
              : form
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
            formaction={action('switchLocale')}
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
            data-preview-link={work}
            ><Icon name="external-link" />{t('admin.content.edit.previewShort')}</Button
          >
        {/if}
      {/snippet}
      {#snippet dock()}
        <Button variant="secondary" form="item-edit" formaction={action('save')}
          >{t('admin.content.edit.save')}</Button
        >
        {#if mainPublication || others.length}<Button href="#publication-panel"
            >{t('admin.content.action.openPublication')}</Button
          >{/if}
      {/snippet}
    </ItemBar>
  {/snippet}

  {#snippet notices()}
    <EditPresence presence={data.presence} reload={discardHref} locale={data.locale} />
    {#if data.invalidInsert}
      <Notice tone="warning"><p>{t('admin.block.insert.invalid')}</p></Notice>
    {/if}
    {#if recovered}
      <!-- Put back after logging in again (session-restore.js): nothing is saved until Save. -->
      <Notice tone="warning">
        <p class="item-undo">
          <span>{refusalCopy(t, form!)}</span>
          <Button variant="secondary" href={discardHref} data-discard
            >{t('admin.content.recovered.discard')}</Button
          >
        </p>
      </Notice>
    {/if}
    {#if !(form && 'locale' in form && !form.conflict)}{@render refusalNotice()}{/if}
    {#if form?.conflict}
      <ConflictNotice conflict={form.conflict} form="item-edit" locale={data.locale} />
    {/if}
    {#if !form}<MergeNotice merge={data} />{/if}
    {#if data.done && data.undo}
      <Notice tone="success">
        <p class="item-undo">
          <span>{t(data.done)}</span>
          <Button
            variant="secondary"
            form="item-edit"
            formaction={action('restore')}
            name="restore"
            value={data.undo}>{t('admin.block.undo')}</Button
          >
        </p>
      </Notice>
    {:else if data.done}
      <Notice tone="success"><p>{fill(t(data.done), { locale: data.doneLocale })}</p></Notice>
    {:else if data.saved && !form && !data.merged}
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
        <!-- What the preview shows, in words (#66 PR 6d): what is typed now, or an older image when
             the newest input could not be shown. One status region, so the switch is announced. -->
        <div class="ui-preview-shows" role="status" data-preview-state="current">
          <p data-preview-shows="current">
            <Badge tone="info">{t('admin.content.preview.kind.input')}</Badge>
            {t('admin.content.preview.kind.inputHint')}
          </p>
          <div data-preview-shows="behind">
            <Notice tone="warning" live={false} title={t('admin.content.preview.behind.title')}>
              <p>{t('admin.content.preview.behind.body')}</p>
            </Notice>
          </div>
        </div>
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
    <ItemPanels campaign={data.campaign} {article} locale={data.locale} />
    {#if mainPublication || others.length}
      <PublicationDrawer
        id="publication-panel"
        title={t('admin.content.publication.title')}
        locale={data.locale}
        refused={!!(form && 'locale' in form && !form.conflict)}
      >
        {#if form && 'locale' in form && !form.conflict}{@render refusalNotice()}{/if}
        {#if mainPublication}{@render statusCard(mainPublication)}{:else}<h3>
            {languageName(work)}
          </h3>
          <p>{fill(t('admin.locale.translate.title'), { locale: work })}</p>{/if}
        {#if multi && others.length}
          <section aria-labelledby="other-locales" class="item-locales">
            <h3 id="other-locales">{t('admin.content.item.locales')}</h3>
            {#each others as o (o.locale)}
              <div class="ui-publication-locale">
                <div>
                  <strong>{languageName(o.locale)}</strong>
                  {#if o.publication}<span>{stateOf(o.publication).text}</span>{/if}
                  {#if o.state !== 'ok'}<span class="ui-hint">{stateWords(o.state)}</span>{/if}
                </div>
                <Button
                  variant="secondary"
                  formaction={action('switchLocale')}
                  name="to"
                  value={o.locale}>{t('admin.block.card.edit')}</Button
                >
              </div>
            {/each}
          </section>
        {/if}
        <p class="ui-hint">{t('admin.content.publication.chosenLocale')}</p>
      </PublicationDrawer>
    {/if}
    <section aria-labelledby="this-item">
      <h2 id="this-item">{t('admin.content.item.title')}</h2>
      <HeaderFields
        legacy={!data.values.articleProfile}
        locale={data.locale}
        {work}
        {article}
        {v}
        items={data.items}
        choices="{base}/content/choices?locale={encodeURIComponent(work)}"
        bad={(name) => issues.some((i) => i.name === name || i.name.startsWith(`${name}.`))}
      />
      <MetaList items={[{ term: t('admin.content.item.url'), value: data.item.path }]} />
      {#if data.canWrite}
        <SlugField
          locale={data.locale}
          slug={v('slug')}
          baseSlug={v('baseSlug')}
          stored={data.item.slug}
          flagged={flagged('slug')}
        />
      {/if}
      <OldAddresses {data} {action} />
      {#if article}
        <AuthorPicker
          locale={data.locale}
          {authors}
          selected={list('authorIds')}
          write={data.canWrite}
          name={v('newAuthorName')}
          slug={v('newAuthorSlug')}
          action={action('addAuthor')}
        />
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
        {@render translateLinks('sectionId', 'sectionId', work, '')}
        {@render text('tags', t('admin.content.field.tags'), { max: 2000 })}
      {/if}
      <DossierFields
        locale={data.locale}
        {base}
        choices={dossiers}
        selected={list('dossierIds')}
        noBox={v('noDossierBox') === 'on'}
        write={data.canWrite}
        removeAction={action('save')}
        invalid={flagged('dossiers')}
      />
      <p>
        <a href="{base}/content/{data.item.id}/revisions">{t('admin.content.revisions')}</a>
      </p>
    </section>
    {#if data.canWrite}<EditorShortcuts locale={data.locale} />{/if}
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
  /* The notice's words and its "Undo" share a line while both fit, and wrap otherwise. */
  .item-undo {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
</style>
