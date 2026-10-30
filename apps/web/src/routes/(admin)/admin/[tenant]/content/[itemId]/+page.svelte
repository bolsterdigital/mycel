<!-- The edit screen of one item (TODO #66 PR 2, brief edit-screen § 4): one form for the whole
     document, under an ItemBar with the state in words, Preview and Save. The main column has
     three sections a script may show as tabs (#66 PR 6): Content (the title large and first, the
     lead, the featured image and the blocks in reading order), Search and sharing, and Settings
     (access only on an item that has it, corrections, languages), the last two folded. Each block
     is a Panel in the same form, with move, remove (a confirmation inside the card) and insert
     (an empty block at its place, stored with the next save); every such button saves what was
     typed first. The side column has the status card of each locale (the state in words, the
     main action by state, scheduling folded, view on the site) and "This item" (address, authors,
     section and tags as WordPress and Ghost have them, revisions). A failed save comes back with
     what was typed and every fold open; a conflict also shows who saved in between and what
     changed (ADR 018 rule 2). The restricted note comes before every publication button and
     cannot be closed (ADR 018 rule 6). -->
<script lang="ts">
  import BlockFields from '#lib/admin/BlockFields.svelte';
  import Diff from '#lib/admin/Diff.svelte';
  import { issueLabel } from '#lib/admin/issue-label.js';
  import {
    Actions,
    Button,
    Checkbox,
    Choices,
    EditPage,
    EmptyState,
    Field,
    Fieldset,
    ItemBar,
    MediaPicker,
    MetaList,
    Notice,
    Panel,
    Select,
    StatusCard,
    Tabs,
  } from '#lib/admin/ui/index.js';
  import { BLOCK_DEFINITIONS, type BlockType } from '@mycel/core';
  import { fill, ui, type UiKey } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const posted = $derived(form && 'values' in form ? form.values : null);
  const values: Record<string, string | string[]> = $derived(posted ?? data.values);
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
  const multi = $derived(data.docLocales.length > 1);
  /** " (en)" after a per-locale label when the item has more than one language. */
  const per = (l: string) => (multi ? ` (${l})` : '');
  const base = $derived(`/admin/${data.tenant.slug}`);
  const article = $derived(data.item.type === 'article');
  const defaultLocale = $derived(data.item.defaultLocale);
  const title = $derived(
    (data.values[`title.${defaultLocale}`] as string | undefined) || t('admin.content.untitled')
  );
  const typeName = $derived(t(`admin.content.type.${data.item.type}` as UiKey));
  const baseRevision = $derived(v('baseRevisionId') || data.revision.id);
  /** Folded groups open after a failed save, so a field the summary links to is in view. */
  const folded = $derived(!form);
  const mainPublication = $derived(
    data.item.publication.find((p) => p.locale === defaultLocale) ?? data.item.publication[0]
  );
  const otherPublications = $derived(data.item.publication.filter((p) => p !== mainPublication));
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

  /** A field name of a block as words: the field's label, plus its locale. */
  const fieldLabel = (name: string): string => {
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
    name.startsWith('new.')
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
  const preview = (l: string) =>
    `${base}/preview/item/${data.item.id}?revision=${data.revision.id}&locale=${l}`;
  const assist = (params: Record<string, string>) =>
    `${base}/content/${data.item.id}/assist?${new URLSearchParams(params)}`;
  /** The values of a block's fields: what a refused post typed, else what is stored. */
  const blockValues = (b: (typeof data.blocks)[number]): Record<string, string> => {
    if (!posted) return b.values;
    const prefix = `b.${b.id}.`;
    const typed = Object.entries(posted).filter(
      (e): e is [string, string] => e[0].startsWith(prefix) && typeof e[1] === 'string'
    );
    return typed.length ? Object.fromEntries(typed) : b.values;
  };
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
      values={p.values}
      locales={data.docLocales}
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

{#snippet blockCard(b: (typeof data.blocks)[number], i: number)}
  {@const prefix = `b.${b.id}.`}
  {@const refused = issues.some((x) => x.name.startsWith(prefix))}
  <Panel
    id="block-{b.id}"
    class="block"
    open={refused || data.openBlocks.includes(b.id)}
    summary="{i + 1}. {t(`admin.block.type.${b.type}` as UiKey)}{b.summary ? `: ${b.summary}` : ''}"
  >
    <BlockFields
      fields={BLOCK_DEFINITIONS[b.type].fields}
      values={blockValues(b)}
      locales={data.docLocales}
      idPrefix="b-{b.id}"
      {prefix}
      media={data.media}
      {base}
      upload={data.upload}
      items={data.items}
      invalid={issues.map((x) => x.name)}
      locale={data.locale}
    />
    {#if data.assistEnabled && b.type === 'image' && b.values[`${prefix}p.decorative`] !== 'on'}
      <p class="ui-hint">
        {#each data.docLocales as l (l)}
          <a href={assist({ task: 'alt', block: b.id, locale: l })}>{t('admin.assist.alt')} ({l})</a
          >
        {/each}
      </p>
    {/if}
    {#if data.assistEnabled && b.type === 'rich-text'}
      <p class="ui-hint">
        {#each data.docLocales as l (l)}
          {#each data.docLocales.filter((source: string) => source !== l && !!b.values[`${prefix}p.content.${source}`]) as source (source)}
            <a
              href={assist({
                task: 'translate',
                from: source,
                to: l,
                target: `blocks.${b.id}.props.content`,
              })}>{fill(t('admin.assist.translateFrom'), { locale: source })} ({l})</a
            >
          {/each}
        {/each}
      </p>
    {/if}
    {#if data.canWrite}
      <Actions stack>
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
      </Actions>
      <details class="ui-fold">
        <summary>{t('admin.block.insert.fold')}</summary>
        <Select
          id="insert-type-{b.id}"
          name="insertType.{b.id}"
          label={t('admin.block.insert.type')}
          locale={data.locale}
          options={blockTypeOptions}
        />
        <Actions stack>
          <Button variant="secondary" formaction="?/insert" name="insert" value="before:{b.id}"
            >{t('admin.block.insert.before')}</Button
          >
          <Button variant="secondary" formaction="?/insert" name="insert" value="after:{b.id}"
            >{t('admin.block.insert.after')}</Button
          >
        </Actions>
      </details>
      <details class="ui-fold">
        <summary>{t('admin.block.remove')}</summary>
        <p>{fill(t('admin.block.remove.ask'), { n: i + 1 })}</p>
        <Actions>
          <Button variant="danger" formaction="?/remove" name="remove" value={b.id}
            >{t('admin.block.remove.confirm')}</Button
          >
        </Actions>
      </details>
    {/if}
  </Panel>
{/snippet}

{#snippet contentTab()}
  <input type="hidden" name="baseRevisionId" value={baseRevision} />
  <div class="ui-field">
    <label class="ui-visually-hidden" for="title.{defaultLocale}"
      >{t('admin.content.edit.titleLabel')}{per(defaultLocale)}</label
    >
    <input
      class="ui-title-input"
      size="1"
      id="title.{defaultLocale}"
      name="title.{defaultLocale}"
      type="text"
      maxlength="200"
      required
      value={v(`title.${defaultLocale}`)}
    />
  </div>
  {@render translateLinks('title', 'title', defaultLocale, t('admin.content.field.title'))}
  {#each docLocales.filter((l) => l !== defaultLocale) as l (l)}
    {@render text(`title.${l}`, `${t('admin.content.field.title')} (${l})`)}
    {@render translateLinks('title', 'title', l, t('admin.content.field.title'))}
  {/each}
  {#if article}
    {#each docLocales as l (l)}
      {@render area(`lead.${l}`, `${t('admin.content.field.lead')}${per(l)}`, 1000)}
      {@render translateLinks('lead', 'lead', l, t('admin.content.field.lead'))}
    {/each}
  {/if}
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

  <section aria-labelledby="blocks" class="item-blocks">
    <h3 id="blocks">{t('admin.block.title')}</h3>
    {#if article}
      <p>
        <Button variant="secondary" href="{base}/content/{data.item.id}/write"
          >{t('admin.editor.title')}</Button
        >
      </p>
    {/if}
    {#if data.blocks.length === 0 && !pending}
      <EmptyState title={t('admin.block.empty')} level={3} />
    {/if}
    {#each data.blocks as b, i (b.id)}
      {#if pending?.place === 'before' && pending.anchor === b.id}{@render pendingCard(
          pending
        )}{/if}
      {@render blockCard(b, i)}
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

{#snippet findabilityTab()}
  <Fieldset legend={t('admin.content.edit.seo')} collapsed={folded}>
    {#each docLocales as l (l)}
      {@render text(`seoTitle.${l}`, `${t('admin.content.field.seoTitle')}${per(l)}`)}
      {@render translateLinks('seoTitle', 'seo.title', l, t('admin.content.field.seoTitle'))}
      {@render area(
        `seoDescription.${l}`,
        `${t('admin.content.field.seoDescription')}${per(l)}`,
        500
      )}
      {@render translateLinks(
        'seoDescription',
        'seo.description',
        l,
        t('admin.content.field.seoDescription')
      )}
    {/each}
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
      hint={t('admin.content.field.shareImageHint')}
      locale={data.locale}
      value={v('shareImageId')}
      options={data.media}
      {base}
      upload={data.upload}
    />
  </Fieldset>
{/snippet}

{#snippet settingsTab()}
  {#if data.showAccess}
    <Fieldset legend={t('admin.content.edit.access')} collapsed={folded}>
      <Select
        id="level"
        name="level"
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
        <p>{c.date}: {c.text[defaultLocale] ?? Object.values(c.text)[0]}</p>
      {/each}
      <Field
        id="correctionDate"
        name="correctionDate"
        type="date"
        label={t('admin.content.edit.correctionDate')}
        locale={data.locale}
        value={v('correctionDate')}
      />
      {#each docLocales as l (l)}
        {@render area(
          `correctionText.${l}`,
          `${t('admin.content.edit.correctionText')}${per(l)}`,
          2000
        )}
      {/each}
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
      options={data.locales.map((l) => ({ value: l, label: l }))}
    />
  </Fieldset>
{/snippet}

{#snippet statusCard(p: Publication, level: 2 | 3)}
  {@const state = stateOf(p)}
  <StatusCard
    id="publication-{p.locale}"
    title={multi
      ? fill(t('admin.content.publication.locale'), { locale: p.locale })
      : t('admin.content.edit.side')}
    state={state.text}
    tone={state.tone}
    {level}
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
      <Notice tone="warning" live={false}><p>{t('admin.assist.unreviewed')} ({p.locale})</p></Notice
      >
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
          >{t(p.live ? 'admin.content.action.publishChanges' : 'admin.content.action.publish')}{per(
            p.locale
          )}</Button
        >
      {/if}
      {#if p.href}
        <Button
          variant={p.live && !p.changes ? 'primary' : 'secondary'}
          href={p.href}
          aria-describedby="new-tab"
          target="_blank">{t('admin.content.action.view')}{per(p.locale)}</Button
        >
      {/if}
      {#if data.canPublish && p.pin && !p.pin.revision.latest}
        <Button variant="secondary" formaction="?/repin" name="locale" value={p.locale}
          >{t('admin.content.action.repin')}{per(p.locale)}</Button
        >
      {/if}
      {#if data.canPublish && p.pin}
        <Button variant="secondary" formaction="?/unschedule" name="locale" value={p.locale}
          >{t('admin.content.action.unschedule')}{per(p.locale)}</Button
        >
      {/if}
      {#if data.canPublish && p.live}
        <Button variant="secondary" formaction="?/unpublish" name="locale" value={p.locale}
          >{t('admin.content.action.unpublish')}{per(p.locale)}</Button
        >
      {/if}
    {/snippet}
    {#snippet more()}
      {#if data.canPublish}
        <details class="ui-fold" open={form && 'locale' in form && form.locale === p.locale}>
          <summary>{t('admin.content.action.scheduleFold')}{per(p.locale)}</summary>
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
              >{t('admin.content.action.schedule')}{per(p.locale)}</Button
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
    <ItemBar
      back={{
        href: `${base}/content?type=${data.item.type}`,
        label: t(article ? 'admin.content.filter.article' : 'admin.content.filter.page'),
      }}
      title={fill(t('admin.content.edit.title'), { type: typeName })}
      state={state?.text}
      stateHref={mainPublication ? `#publication-${mainPublication.locale}` : undefined}
      tone={state?.tone}
    >
      {#snippet actions()}
        {#each data.docLocales as l (l)}
          <Button variant="secondary" href={preview(l)} target="_blank" aria-describedby="new-tab"
            >{t('admin.content.edit.previewShort')}{per(l)}</Button
          >
        {/each}
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
      { id: 'findability', label: t('admin.content.tab.findability'), content: findabilityTab },
      { id: 'settings', label: t('admin.content.tab.settings'), content: settingsTab },
    ]}
  />

  {#if !article && data.canWrite}
    <section
      class="ui-section live-preview"
      data-live-preview
      data-item-id={data.item.id}
      data-preview-action="{base}/preview/draft"
      hidden
      aria-labelledby="live-preview-title"
    >
      <h2 id="live-preview-title">{t('admin.content.preview.live')}</h2>
      <Field
        id="live-preview-locale"
        label={t('admin.content.preview.locale')}
        locale={data.locale}
      >
        {#snippet control(attributes)}
          <select {...attributes} data-live-preview-locale>
            {#each data.docLocales as l (l)}<option value={l}>{l}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <iframe
        name="mycel-live-preview"
        title={t('admin.content.preview.live')}
        data-live-preview-frame
      ></iframe>
      <p class="ui-hint">{t('admin.content.preview.keyboard')}</p>
    </section>
    <script type="module" src="/_admin/live-preview-parent.js"></script>
  {/if}

  {#snippet aside()}
    {#if mainPublication}{@render statusCard(mainPublication, 2)}{/if}
    {#if otherPublications.length}
      <section aria-labelledby="other-locales">
        <h2 id="other-locales">{t('admin.content.item.locales')}</h2>
        {#each otherPublications as p (p.locale)}{@render statusCard(p, 3)}{/each}
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
