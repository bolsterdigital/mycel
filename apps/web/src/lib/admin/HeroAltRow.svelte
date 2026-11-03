<!-- The hero image's description line (#158): state and action in the summary, visible without a
     click, the field behind it. Every state's words are in the markup, so the screen's script only
     chooses which stands (static/_admin/edit-screen.js) and the saved state needs no script. The
     marker tells the server the field was on the form. Rendered without an image too, hidden, so a
     first image chosen with the script can be described before saving. Rejected: the sentence that
     explained alt text as a toggle label (feedback 2026-11-03), and an always-open field, which
     hides nothing but costs every item four lines. -->
<script lang="ts">
  import { fill, ui } from '../../i18n/index.js';
  import { heroAltView } from './hero-alt.js';
  import { Checkbox, Field, Icon } from './ui/index.js';

  let {
    locale,
    work,
    locales,
    image,
    savedImage,
    text,
    savedText,
    others,
    clearing = false,
    flagged = false,
  }: {
    /** The language of the admin. */
    locale: string;
    /** The content locale on screen. */
    work: string;
    /** The locales of the item. */
    locales: readonly string[];
    /** The chosen image, '' for none. */
    image: string;
    savedImage: string;
    /** What the field holds now, also after a refused save. */
    text: string;
    savedText: string;
    /** Stored text of the other locales: a post only carries the locale on screen. */
    others: Readonly<Record<string, string | undefined>>;
    clearing?: boolean;
    flagged?: boolean;
  } = $props();

  const t = $derived(ui(locale));
  const multi = $derived(locales.length > 1);
  const view = $derived(
    heroAltView({ text, others, replaced: !!image && image !== savedImage, clearing, flagged })
  );
  const names = $derived(new Intl.DisplayNames([locale], { type: 'language' }));
  const nameOf = (l: string) => names.of(l) ?? l;
  const listOf = (ls: readonly string[]) =>
    new Intl.ListFormat(locale, { type: 'conjunction' }).format(ls.map(nameOf));
  const allOthers = $derived(Object.keys(others));
  /** Locales with text as stored, whatever the image is now: the script may bring them back. */
  const storedOthers = $derived(allOthers.filter((l) => others[l]?.trim()));
  const keptLacking = $derived(allOthers.filter((l) => !storedOthers.includes(l)));
  const hasOldText = $derived(!!savedText.trim() || storedOthers.length > 0);
  const refusedFor = $derived(view.state === 'described' ? view.lacking : [work]);
</script>

<input type="hidden" name="heroAltShown" value="1" />
<details
  class="hero-alt"
  data-hero-alt
  data-tone={view.tone}
  data-saved-image={savedImage}
  data-saved-text={savedText}
  data-others={allOthers.length}
  data-stored-others={storedOthers.length}
  data-flagged={flagged ? '' : undefined}
  hidden={!image}
  open={flagged}
>
  <summary>
    <span class="status">
      <span data-hero-alt-state="described" hidden={view.state !== 'described'}>
        <span class="icon ok"><Icon name="circle-check" /></span>
        <span class="head"
          >{t('admin.content.heroAlt.described')}{#if multi}<span class="tag"
              >{` · ${nameOf(work)}`}</span
            >{/if}</span
        >
        <span class="quote" lang={work} data-hero-alt-quote>{text}</span>
        <span
          class="extra"
          data-hero-alt-extra="kept"
          hidden={view.state !== 'described' || image !== savedImage || !keptLacking.length}
          >{fill(t('admin.content.heroAlt.alsoMissing'), { locales: listOf(keptLacking) })}</span
        >
        <span
          class="extra"
          data-hero-alt-extra="replaced"
          hidden={view.state !== 'described' || image === savedImage || !allOthers.length}
          >{fill(t('admin.content.heroAlt.alsoMissing'), { locales: listOf(allOthers) })}</span
        >
      </span>
      <span data-hero-alt-state="missing" hidden={view.state !== 'missing'}>
        <span class="icon warn"><Icon name="triangle-alert" /></span>
        <span class="icon err"><Icon name="circle-alert" /></span>
        <span class="head"
          >{fill(t('admin.content.heroAlt.missing'), { locale: nameOf(work) })}</span
        >
        <span class="body">{t('admin.content.heroAlt.missingBody')}</span>
      </span>
      <span data-hero-alt-state="decorative" hidden={view.state !== 'decorative'}>
        <span class="icon"><Icon name="circle-minus" /></span>
        <span class="head">{t('admin.content.heroAlt.decorative')}</span>
        <span class="body">{t('admin.content.heroAlt.decorativeBody')}</span>
      </span>
      <span data-hero-alt-state="cleared" hidden={view.state !== 'cleared'}>
        <span class="icon"><Icon name="circle-minus" /></span>
        <span class="head">{t('admin.content.heroAlt.decorative')}</span>
        <span class="body">{t('admin.content.heroAlt.clearedBody')}</span>
      </span>
      <span data-hero-alt-state="fresh" hidden={view.state !== 'fresh'}>
        <span class="icon"><Icon name="info" /></span>
        <span class="head">{t('admin.content.heroAlt.fresh')}</span>
        <span class="body"
          >{t(
            hasOldText ? 'admin.content.heroAlt.freshBody' : 'admin.content.heroAlt.freshBodyFirst'
          )}</span
        >
      </span>
    </span>
    <span class="act">
      <span
        data-hero-alt-action="edit"
        hidden={view.state !== 'described' && view.state !== 'cleared'}
        >{t('admin.content.heroAlt.edit')}</span
      >
      <span
        data-hero-alt-action="describe"
        hidden={view.state === 'described' || view.state === 'cleared'}
        >{t('admin.content.heroAlt.describe')}</span
      >
      <Icon name="chevron-down" />
    </span>
  </summary>
  <div class="panel">
    <Field
      id="heroAlt"
      label={multi
        ? fill(t('admin.content.heroAlt.fieldIn'), { locale: nameOf(work) })
        : t('admin.content.heroAlt.field')}
      hint={t('admin.content.heroAlt.hint')}
      {locale}
      error={flagged
        ? fill(t('admin.content.heroAlt.refused'), { locales: listOf(refusedFor) })
        : undefined}
    >
      {#snippet control(attributes)}
        <textarea name="heroAlt.{work}" maxlength="1000" rows="2" lang={work} {...attributes}
          >{text}</textarea
        >
      {/snippet}
    </Field>
    <p class="ui-hint" data-hero-alt-empty="decorative" hidden={view.described.length > 0}>
      {t('admin.content.heroAlt.empty')}
    </p>
    {#if storedOthers.length}
      <p class="ui-hint" data-hero-alt-empty="open" hidden={view.described.length === 0}>
        {fill(t('admin.content.heroAlt.emptyPartial'), { locales: listOf(storedOthers) })}
      </p>
      <div class="others" data-hero-alt-others hidden={view.described.length === 0}>
        {#each storedOthers as other (other)}
          <p class="other">
            <span class="other-name">{nameOf(other)}</span>
            <span lang={other}>{others[other]}</span>
          </p>
        {/each}
        <Checkbox
          id="heroDecorative"
          name="heroDecorative"
          label={t('admin.content.heroAlt.clear')}
          checked={clearing}
        />
      </div>
    {/if}
  </div>
</details>

<style>
  .hero-alt {
    min-width: 0;
    border-block-start: var(--border-width) solid var(--color-border);
  }
  .hero-alt[hidden],
  .hero-alt [hidden] {
    display: none;
  }
  summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    padding: var(--space-1) var(--space-2);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:focus-visible {
    outline: 3px solid var(--color-focus);
    outline-offset: -3px;
    border-radius: var(--radius);
  }
  /* The last row of the group: the fieldset's corners, also when the tone colours it. */
  details:not([open]) > summary,
  .panel {
    border-end-start-radius: var(--radius);
    border-end-end-radius: var(--radius);
  }
  [data-tone='warn'] > summary {
    color: var(--status-warning-fg);
    background: var(--status-warning-bg);
  }
  [data-tone='info'] > summary {
    color: var(--status-info-fg);
    background: var(--status-info-bg);
  }
  [data-tone='err'] > summary {
    color: var(--status-error-fg);
    background: var(--status-error-bg);
  }
  .status {
    flex: 1 1 16rem;
    min-width: 0;
  }
  .status > span {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    column-gap: var(--space-1);
    align-items: start;
  }
  .icon {
    grid-row: 1;
    display: inline-flex;
    margin-block-start: 0.1em;
  }
  .icon.ok {
    color: var(--status-success-fg);
  }
  /* One word-and-icon pair per tone: the same state is a warning until a refusal names it. */
  [data-tone='err'] .icon.warn,
  :not([data-tone='err']) > summary .icon.err {
    display: none;
  }
  .head {
    grid-column: 2;
    font-weight: 600;
    overflow-wrap: break-word;
  }
  .tag {
    font-weight: 400;
  }
  .body,
  .quote,
  .extra {
    grid-column: 2;
    overflow-wrap: anywhere;
  }
  .body {
    overflow-wrap: break-word;
  }
  .quote {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .extra {
    margin-block-start: var(--space-0);
    overflow-wrap: break-word;
    font-weight: 600;
    color: var(--status-warning-fg);
  }
  [data-tone='err'] .extra {
    color: inherit;
  }
  .act {
    display: inline-flex;
    align-items: center;
    gap: var(--space-0);
    min-height: var(--tap);
    max-width: 100%;
    padding: 0.625rem 0.75rem;
    border-radius: var(--radius);
    font-weight: 600;
    line-height: 1.25;
    color: var(--color-link);
    background: var(--color-surface);
    box-shadow: inset 0 0 0 var(--control-border-width) currentColor;
  }
  summary:hover .act {
    text-decoration: underline;
  }
  .act :global(svg) {
    flex: none;
    transition: transform 0.12s;
  }
  [open] > summary .act :global(svg) {
    transform: rotate(180deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .act :global(svg) {
      transition: none;
    }
  }
  .panel {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2) var(--space-2);
    border-block-start: var(--border-width) solid var(--color-border);
  }
  .others {
    display: grid;
    gap: var(--space-1);
  }
  .other {
    margin: 0;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius);
    overflow-wrap: anywhere;
    background: var(--status-neutral-bg);
    color: var(--status-neutral-fg);
  }
  .other-name {
    display: block;
    font-weight: 600;
  }
</style>
