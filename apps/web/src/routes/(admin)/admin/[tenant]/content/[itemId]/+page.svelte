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
     locale the item lacks shows "start the translation" in place of the content.
     After an expired session, the input a save carried comes back through the `recover` action
     (static/_admin/session-restore.js, brief admin-entry): the same rendering as a refused save,
     with a notice and Discard. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { earlyInput } from '#lib/editor/early-input.js';
  import { typedOver } from '#lib/editor/block-form.js';
  import PublicationDrawer from '#lib/admin/ui/feedback/PublicationDrawer.svelte';
  import WritingSurface from '#lib/editor/WritingSurface.svelte';
  import ItemTitleField from '#lib/editor/ItemTitleField.svelte';
  import BlockFields from '#lib/admin/block-fields/BlockFields.svelte';
  import HeroAltRow from '#lib/admin/hero-alt/HeroAltRow.svelte';
  import ReviewOffer from '#lib/admin/review-offer/ReviewOffer.svelte';
  import Diff from '#lib/admin/Diff.svelte';
  import Inherited from '#lib/admin/Inherited.svelte';
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
    Choices,
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
  import { BLOCK_ICONS, BLOCK_PRESENTATION, blockName } from '#lib/admin/block-presentation.js';
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
      ...(data.canWrite ? ['/_admin/edit-screen.js', '/_admin/session-restore.js'] : []),
      ...(!data.translating && data.item.type === 'page' && data.canWrite
        ? ['/_admin/live-preview-parent.js']
        : []),
    ]) {
      // Not a script element: its `src` takes a Trusted Type, and these are fixed addresses.
      void import(/* @vite-ignore */ src);
    }
  });
  const early = earlyInput('item-edit');
  const earlyProse = Object.keys(early).some((name) =>
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
  const pending = $derived(form && 'pending' in form ? form.pending : data.pending);
  const issues = $derived<{ name: string; list?: string; copy: string }[]>(
    form && 'fieldIssues' in form ? (form.fieldIssues ?? []) : []
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

  const languageName = (locale: string) =>
    new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;

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

  /** The document fields a refused save can name (`documentFieldIssues`), with their label. */
  const DOC_FIELDS: Record<string, UiKey> = {
    canonical: 'admin.content.field.canonical',
    tags: 'admin.content.field.tags',
    level: 'admin.content.field.level',
    teaser: 'admin.content.field.teaser',
    teaserBlocks: 'admin.content.field.teaserBlocks',
    locales: 'admin.content.new.locales',
    correctionDate: 'admin.content.edit.correctionDate',
    slug: 'admin.content.slug',
    heroAlt: 'admin.content.field.heroAlt',
  };
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
  const blockValues = (b: (typeof data.blocks)[number]) =>
    typedOver(b.values, { ...posted, ...early }, `b.${b.id}.`);
  /** The chain of one locale (#86); images are the same in every locale. */
  const chain = (l: string) => data.effective[l] ?? data.effective[defaultLocale]!;
  /** Whether a field is empty both as typed and as stored, so what it inherits applies. */
  const empty = (name: string) => !v(name).trim() && !data.values[name];
  const thumbOf = (id: string | null) =>
    id && data.media.some((m) => m.id === id && m.thumb) ? thumbPath(base, id) : null;
  const cardLabels = $derived({
    edit: t('admin.block.card.edit'),
    done: t('admin.block.card.done'),
    more: t('admin.block.card.more'),
    block: t('admin.block.card.block'),
    collapse: t('admin.block.card.collapse'),
    expand: t('admin.block.card.expand'),
  });
  /** A locale where this block keeps the item from being ready: the shown one first (#159). */
  const notReadyIn = (id: string): string | undefined => {
    const has = (p: Publication) => p.issues.some((x) => x.field === `block-${id}`);
    const locales = data.item.publication.filter(has).map((p) => p.locale);
    return locales.includes(work) ? work : locales[0];
  };
  /** The one notice a card's head carries: what the last save refused, else what readiness says. */
  const blockNotice = (id: string, refused: boolean): string => {
    if (refused) return t('admin.block.card.refused');
    const locale = notReadyIn(id);
    if (!locale) return '';
    const language = new Intl.DisplayNames([data.locale], { type: 'language' }).of(locale);
    return fill(t('admin.block.card.notReady'), { locale: language ?? locale });
  };
  const groupLabels = $derived({
    display: t('admin.block.group.display'),
    source: t('admin.block.group.source'),
  });
  /** A credit as the page words it (`lib/blocks/Credit.svelte`), in the content locale. */
  const creditLine = (c: MediaCredit): string => creditText(c, creditWords(ui(work)));
  const blockTypeOptions = $derived(
    data.blockTypes.map((type) => ({
      value: type,
      label: t(`admin.block.type.${type}` as const),
      icon: BLOCK_ICONS[type],
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

<!-- A legacy hero's way into the header (ADR 025 rule 5): what would move and what stands in the
     way, both from the same proposal the command applies. One deliberate button, no dialog: it
     writes a new draft, and what is live stays. The block itself stays fully editable below. -->
{#snippet heroConversion(c: NonNullable<typeof data.heroConversion>)}
  {@const label = (field: string, locale: string | null) =>
    t(`admin.content.heroConversion.field.${field}` as UiKey) + (locale ? ` (${locale})` : '')}
  {@const shown = (row: (typeof c.fields)[number]) =>
    `${label(row.field, row.locale)}: ${
      row.field === 'image' ? t('admin.content.heroConversion.imageValue') : row.hero
    }`}
  <Notice tone="warning" live={false} title={t('admin.content.heroConversion.title')}>
    {#if c.conflicts.length}
      <p>{t('admin.content.heroConversion.blocked')}</p>
      <ul>
        {#each c.conflicts as conflict (conflict.code + conflict.locale)}
          {@const row = c.fields.find(
            (f) => f.field === conflict.code && f.locale === conflict.locale
          )}
          <li>
            {t(`admin.content.heroConversion.conflict.${conflict.code}` as const)}
            {#if conflict.locale}({conflict.locale}){/if}
            {#if row && row.field !== 'image'}
              {fill(t('admin.content.heroConversion.differs'), {
                value: row.hero,
                header: row.header ?? '',
              })}
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p>{t('admin.content.heroConversion.ready')}</p>
      <ul>
        {#each c.fields as row (row.field + row.locale)}
          <li>
            {fill(
              t(
                row.header === null
                  ? 'admin.content.heroConversion.moves'
                  : 'admin.content.heroConversion.same'
              ),
              { value: shown(row) }
            )}
          </li>
        {/each}
        {#if c.cta}
          <li>
            {fill(t('admin.content.heroConversion.cta'), {
              labels: c.cta.actions.map((a) => pick(a.label, work, defaultLocale) ?? '').join(', '),
            })}
          </li>
        {/if}
        {#if c.teaser}
          <li>{fill(t('admin.content.heroConversion.teaser'), c.teaser)}</li>
        {/if}
        {#if c.layout.variant !== 'minimal'}
          <li>{fill(t('admin.content.heroConversion.layout'), { variant: c.layout.variant })}</li>
        {/if}
      </ul>
      <Button
        variant="secondary"
        formaction={action('convertHero')}
        name="convertHero"
        value={c.heroId}>{t('admin.content.heroConversion.action')}</Button
      >
    {/if}
  </Notice>
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
    <h3 id="block-new-title">
      {fill(t('admin.block.new'), { type: t(`admin.block.type.${p.type}` as const) })}
    </h3>
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
      row={BLOCK_PRESENTATION[p.type as BlockType].row}
    />
    <Actions>
      <Button formaction={action('save')}>{t('admin.block.new.add')}</Button>
      <Button variant="secondary" formaction={action('discard')} formnovalidate
        >{t('admin.block.new.discard')}</Button
      >
    </Actions>
  </section>
{/snippet}

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
    <BlockText
      view={b.text}
      kindLabel={b.text.kind === 'callout'
        ? t(`admin.block.option.${b.text.variant}` as UiKey)
        : b.text.kind === 'video'
          ? t(`admin.block.option.${b.text.provider}` as UiKey)
          : b.text.kind === 'form'
            ? b.text.form
              ? fill(t('admin.block.form.signup'), { list: b.text.form.list })
              : b.text.unread
                ? t('admin.block.form.unread')
                : t('admin.block.form.missing')
            : b.text.kind === 'paywall'
              ? t('admin.block.paywall.boundary')
              : undefined}
      noteLabel={b.text.kind === 'paywall'
        ? data.restricted
          ? undefined
          : t('admin.block.paywall.public')
        : t('admin.block.form.changed')}
    />
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
    id="block-{b.id}"
    class="block"
    number={i + 1}
    type={t(`admin.block.type.${b.type}` as const)}
    icon={BLOCK_ICONS[b.type]}
    name={blockName(b)}
    nameIfEmpty={b.type === 'image' ? b.image?.label : ''}
    nameLang={work}
    notice={blockNotice(b.id, refused)}
    editable={BLOCK_DEFINITIONS[b.type].fields.length > 0}
    open={refused ||
      !!(form && 'arranged' in form && String(form.arranged).startsWith(prefix)) ||
      data.openBlocks.includes(b.id) ||
      (Array.isArray(early.$openBlocks) && early.$openBlocks.includes(b.id))}
    labels={cardLabels}
  >
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
        locale={data.locale}
        options={blockTypeOptions}
        action="?/insert&locale={work}"
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
    >
      {#snippet related()}
        <HeroAltRow
          locale={data.locale}
          {work}
          locales={docLocales}
          image={v('heroImageId')}
          savedImage={saved('heroImageId')}
          text={v(`heroAlt.${work}`)}
          savedText={saved(`heroAlt.${work}`)}
          others={Object.fromEntries(
            docLocales.filter((l) => l !== work).map((l) => [l, saved(`heroAlt.${l}`)])
          )}
          clearing={v('heroDecorative') === 'on'}
          flagged={heroAltRefused}
        />
      {/snippet}
    </MediaPicker>
    {#if data.heroConversion}
      <div id="hero-conversion">{@render heroConversion(data.heroConversion)}</div>
    {/if}
  </section>

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
    <!-- Above the blocks, outside the writer's document; the script reveals it, as without
         JavaScript nothing collapses. Only with a card to act on: an article's prose has none. -->
    {#if data.blocks.some((b) => !(article && data.canWrite && b.type === 'rich-text'))}
      <div class="ui-block-card-bar" data-block-bar hidden>
        <button type="button" data-block-all="collapse"
          ><Icon name="chevron-up" />{t('admin.block.card.collapseAll')}</button
        >
        <button type="button" data-block-all="expand"
          ><Icon name="chevron-down" />{t('admin.block.card.expandAll')}</button
        >
      </div>
    {/if}
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
      {#if pending?.place === 'after' && pending.anchor === b.id}{@render pendingCard(pending)}{/if}
    {/each}
    {#if pending?.place === 'end'}{@render pendingCard(pending)}{/if}
    {#if data.canWrite}
      <div id="insert-end">
        <Fieldset legend={t('admin.block.add')}>
          <BlockInserter
            id="end"
            place="end"
            label={t('admin.block.insert.end')}
            locale={data.locale}
            options={blockTypeOptions}
            action="?/insert&locale={work}"
          />
        </Fieldset>
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
      {@render issueList(p.issues)}
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
        {@render issueList(form.issues ?? [])}
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
        label: t(article ? 'admin.content.filter.article' : 'admin.content.filter.page'),
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
      {#if article}
        <!-- #158: the choice sets how title, lead and image open the article together, so it does
             not sit with the image. A hidden `headerLayout` on a page would give pages a layout. -->
        <Select
          id="headerLayout"
          name="headerLayout"
          label={t('admin.content.field.headerLayout')}
          hint={t('admin.content.field.headerLayoutHint')}
          locale={data.locale}
          value={v('headerLayout') || 'standard'}
          options={[
            { value: 'standard', label: t('admin.content.headerLayout.standard') },
            { value: 'cover', label: t('admin.content.headerLayout.cover') },
          ]}
        />
        {#if v('headerLayout') === 'cover' && !v('heroImageId')}
          <Notice tone="warning" live={false}
            ><p>{t('admin.content.headerLayout.noImage')}</p></Notice
          >
        {/if}
      {/if}
      <MetaList items={[{ term: t('admin.content.item.url'), value: data.item.path }]} />
      {#if data.item.slugFixed}
        <p class="ui-hint">{t('admin.content.slug.fixed')}</p>
      {:else if data.canWrite}
        <details class="ui-fold item-slug" open={flagged('slug')}>
          <summary>{t('admin.content.slug.change')}</summary>
          <!-- The address this form was rendered with: a save changes the slug only when the
               field differs from it, so a tab left open cannot move another tab's address back. -->
          <input type="hidden" name="baseSlug" value={v('baseSlug') || data.item.slug} />
          <Field
            id="slug"
            name="slug"
            label={t('admin.content.slug')}
            locale={data.locale}
            size="m"
            hint={t('admin.content.slug.editHint')}
            required
            maxlength={63}
            pattern={'[a-z0-9][a-z0-9-]{0,62}'}
            autocapitalize="off"
            spellcheck={false}
            invalid={flagged('slug')}
            value={v('slug') || data.item.slug}
          />
        </details>
      {/if}
      {#if article}
        <div id="authors">
          <Choices
            id="author"
            name="authorIds"
            type="checkbox"
            searchable
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
    {#if data.canWrite}
      <!-- Every key here is the screen's script; without it the panel stays hidden. -->
      <details class="ui-fold item-shortcuts" data-shortcuts hidden>
        <summary>{t('admin.content.keys.title')}</summary>
        <dl>
          <dt><kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>⌘</kbd>+<kbd>S</kbd></dt>
          <dd>{t('admin.content.keys.save')}</dd>
          <dt><kbd>Esc</kbd></dt>
          <dd>{t('admin.content.keys.escape')}</dd>
          <dt><kbd>Enter</kbd></dt>
          <dd>{t('admin.content.keys.search')}</dd>
          <dt><kbd>?</kbd></dt>
          <dd>{t('admin.content.keys.open')}</dd>
        </dl>
      </details>
    {/if}
  {/snippet}
</EditPage>

<style>
  /* The hero and its description are one group (#158); the shared picker stays frameless. */
  .item-header :global(#heroImageId) {
    gap: 0;
    padding: 0;
    border: var(--border-width) solid var(--color-border-strong);
    border-radius: var(--radius);
  }
  .item-header :global(#heroImageId > legend) {
    margin-inline-start: var(--space-1);
    padding-inline: var(--space-0);
    margin-block-end: 0;
  }
  .item-header :global(#heroImageId .ui-media-picker-selection) {
    padding: var(--space-1) var(--space-2);
  }
  .item-header :global(#heroImageId .ui-media-picker-related) {
    display: block;
  }
  .native-block {
    border: 0;
    padding: 0;
    margin: 0;
    min-inline-size: 0;
  }
  .native-block[hidden] {
    display: none;
  }
  .item-shortcuts dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-1) var(--space-3);
    margin: var(--space-2) 0 0;
  }
  .item-shortcuts dd {
    margin: 0;
  }
  /* The notice's words and its "Undo" share a line while both fit, and wrap otherwise. */
  .item-undo {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
</style>
