<!-- The edit page of one item (TODO #11 A1, brief #56 § C2) on the edit pattern: the document
     fields as one native form in groups in the order a visitor meets them (title and lead, the
     featured image, then byline, the rarely changed search and correction settings folded away, skill
     cms-inrichting), the blocks under it, and the item's state and publication in the side
     column. A failed save comes back with what was typed and every group open; a conflict also
     shows who saved in between and what changed (ADR 018 rule 2).
     Each block (§ B) is a Panel, open for the block just edited: its fields as one form, then
     move up, move down, remove (a confirmation page) and insert a block before or after it (a
     page with the new block's fields).
     The publication panel (§ A2) has one card per locale: what is live, what is pinned, what stops
     a publish, and up to four actions, each its own form, in a group that stacks when the card is
     narrow (skill ui-action-layout); the restricted note comes before every button and cannot be
     closed (ADR 018 rule 6). -->
<script lang="ts">
  import BlockFields from '#lib/admin/BlockFields.svelte';
  import Diff from '#lib/admin/Diff.svelte';
  import { issueLabel } from '#lib/admin/issue-label.js';
  import {
    Actions,
    Button,
    Card,
    Checkbox,
    Choices,
    EditPage,
    EmptyState,
    Field,
    Fieldset,
    MediaPicker,
    MetaList,
    Notice,
    Panel,
    Select,
  } from '#lib/admin/ui/index.js';
  import { BLOCK_DEFINITIONS } from '@mycel/core';
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
  const authors = $derived(form?.authors ?? data.authors);
  const sections = $derived(form?.sections ?? data.sections);
  const docLocales = $derived(list('locales'));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const article = $derived(data.item.type === 'article');
  const title = $derived(
    (data.values[`title.${data.item.defaultLocale}`] as string | undefined) ||
      t('admin.content.untitled')
  );
  const typeName = $derived(t(`admin.content.type.${data.item.type}` as UiKey));
  const baseRevision = $derived(v('baseRevisionId') || data.revision.id);
  /** Folded groups open after a failed save, so a field the summary links to is in view. */
  const folded = $derived(!form);
  /** A field name of a block form as words: the field's label, plus its locale. */
  const fieldLabel = (name: string): string => {
    const parts = name.split('.').slice(1);
    const locale = data.docLocales.includes(parts.at(-1) ?? '') ? parts.pop() : null;
    const key = [...parts].reverse().find((p) => !/^\d+$/.test(p) && p !== 'mode');
    const label = key ? t(`admin.block.field.${key}` as UiKey) : t('admin.block.title');
    return locale ? `${label} (${locale})` : label;
  };
  /** An issue path in words: "Titel (en)", "Blok 3: Tekst (nl)", else the path itself. */
  const issueName = (path: string): string => {
    const l = issueLabel(path, data.docLocales);
    if (!l) return path;
    const label = t(l.key as UiKey);
    const named =
      l.block === null ? label : fill(t('admin.content.issue.block'), { n: l.block, field: label });
    return l.locale ? `${named} (${l.locale})` : named;
  };
  const fieldId = (blockId: string, name: string) => `b-${blockId}-${name.replaceAll('.', '-')}`;
  const preview = (l: string) =>
    `${base}/preview/item/${data.item.id}?revision=${data.revision.id}&locale=${l}`;
  const assist = (params: Record<string, string>) =>
    `${base}/content/${data.item.id}/assist?${new URLSearchParams(params)}`;
  const status = (p: { status: string; changes: boolean }) =>
    `${t(`admin.content.status.${p.status}` as UiKey)}${
      p.changes ? `, ${t('admin.content.status.changes')}` : ''
    }`;
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

{#snippet issueList(issues: { path: string; field: string | null; copy: string }[])}
  <ul>
    {#each issues as i (i.path + i.copy)}
      <li>
        {#if i.field}<a href="#{i.field}">{issueName(i.path)}</a>{:else}{issueName(i.path)}{/if}: {t(
          i.copy as UiKey
        )}
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet act(action: string, locale: string, label: string)}
  {#if action === 'publish' && data.canWrite}
    <!-- Part of the edit form: publishing saves what was typed first (proef 4). -->
    <Button form="item-edit" formaction="?/publish" name="locale" value={locale}
      >{fill(label, { locale })}</Button
    >
  {:else}
    <form method="post" action="?/{action}">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="revisionId" value={data.revision.id} />
      <Button variant={action === 'unpublish' ? 'secondary' : 'primary'}
        >{fill(label, { locale })}</Button
      >
    </form>
  {/if}
{/snippet}

{#snippet insert(anchor: string | null, i: number)}
  <form
    id={anchor ? undefined : 'insert-document'}
    method="get"
    action="{base}/content/{data.item.id}/blocks/new"
    class="insert"
  >
    <input type="hidden" name="revision" value={data.revision.id} />
    {#if anchor}<input type="hidden" name="anchor" value={anchor} />{/if}
    <Fieldset
      legend={anchor
        ? fill(t('admin.block.insert.near'), { n: i + 1 })
        : t('admin.block.insert.document')}
    >
      <Select
        id="type-{anchor ?? 'doc'}"
        name="type"
        label={t('admin.block.insert.type')}
        locale={data.locale}
        options={data.blockTypes.map((type) => ({
          value: type,
          label: t(`admin.block.type.${type}` as UiKey),
        }))}
      />
      <Select
        id="place-{anchor ?? 'doc'}"
        name="place"
        label={t('admin.block.insert.place')}
        locale={data.locale}
        options={(anchor ? ['after', 'before'] : ['end', 'start']).map((place) => ({
          value: place,
          label: t(`admin.block.place.${place}` as UiKey),
        }))}
      />
      <Actions><Button variant="secondary">{t('admin.block.insert.go')}</Button></Actions>
    </Fieldset>
  </form>
{/snippet}

<EditPage
  {title}
  locale={data.locale}
  breadcrumb={[
    { label: data.tenant.name, href: base },
    {
      label: t(
        data.item.type === 'page' ? 'admin.content.filter.page' : 'admin.content.filter.article'
      ),
      href: `${base}/content?type=${data.item.type}`,
    },
    { label: title },
  ]}
  description={fill(t('admin.content.edit.revision'), data.revision)}
  asideLabel={t('admin.content.edit.side')}
>
  {#snippet actions()}
    <Button variant="secondary" href="{base}/content/{data.item.id}/revisions"
      >{t('admin.content.revisions')}</Button
    >
    {#each data.item.publication as p (p.locale)}
      <Button variant="secondary" href={preview(p.locale)} target="_blank"
        >{fill(t('admin.content.edit.preview'), { locale: p.locale })}</Button
      >
    {/each}
  {/snippet}

  {#snippet notices()}
    {#if form && !form.conflict}
      <Notice tone="error" title={t('error.summary.title')}>
        {#if form.blockId}
          <p>{t(form.error as UiKey)}</p>
          <ul>
            {#each form.fieldIssues ?? [] as i (i.name + i.copy)}
              <li>
                {#if i.name}<a href="#{fieldId(form.blockId, i.name)}">{fieldLabel(i.name)}</a>:
                {/if}{t(i.copy as UiKey)}
              </li>
            {/each}
          </ul>
        {:else if form.issues?.length}
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

  <form
    id="item-edit"
    method="post"
    action="?/save"
    aria-labelledby="fields"
    class="item-fields"
    data-live-preview-source
  >
    <h2 id="fields">{t('admin.content.edit.fields')}</h2>
    <input type="hidden" name="baseRevisionId" value={baseRevision} />

    <Fieldset legend={article ? t('admin.content.edit.heading') : t('admin.content.field.title')}>
      {#each docLocales as l (l)}
        {@render text(`title.${l}`, `${t('admin.content.field.title')} (${l})`, {
          required: l === data.item.defaultLocale,
        })}
        {@render translateLinks('title', 'title', l, t('admin.content.field.title'))}
      {/each}
      {#if article}
        {#each docLocales as l (l)}
          {@render area(`lead.${l}`, `${t('admin.content.field.lead')} (${l})`, 1000)}
          {@render translateLinks('lead', 'lead', l, t('admin.content.field.lead'))}
        {/each}
      {/if}
    </Fieldset>

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

    {#if article}
      <Fieldset legend={t('admin.content.edit.byline')}>
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
      </Fieldset>
    {/if}

    <Fieldset legend={t('admin.content.edit.access')}>
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

    <Fieldset legend={t('admin.content.edit.seo')} collapsed={folded}>
      {#each docLocales as l (l)}
        {@render text(`seoTitle.${l}`, `${t('admin.content.field.seoTitle')} (${l})`)}
        {@render translateLinks('seoTitle', 'seo.title', l, t('admin.content.field.seoTitle'))}
        {@render area(
          `seoDescription.${l}`,
          `${t('admin.content.field.seoDescription')} (${l})`,
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

    {#if article}
      <Fieldset legend={t('admin.content.field.corrections')} collapsed={folded}>
        {#each data.corrections as c, i (i)}
          <p>{c.date}: {c.text[data.item.defaultLocale] ?? Object.values(c.text)[0]}</p>
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
            `${t('admin.content.edit.correctionText')} (${l})`,
            2000
          )}
        {/each}
      </Fieldset>
    {/if}

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

    <Actions><Button>{t('admin.content.edit.save')}</Button></Actions>
  </form>

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

  <section aria-labelledby="blocks">
    <h2 id="blocks">{t('admin.block.title')}</h2>
    {#if article}
      <p>
        <Button variant="secondary" href="{base}/content/{data.item.id}/write"
          >{t('admin.editor.title')}</Button
        >
      </p>
    {/if}
    {#if data.blocks.length === 0}
      <EmptyState title={t('admin.block.empty')} level={3} />
    {/if}
    {#each data.blocks as b, i (b.id)}
      {@const mine = form?.blockId === b.id}
      {@const values = (mine && form?.blockValues) || b.values}
      <Panel
        id="block-{b.id}"
        class="block"
        open={mine || data.openBlock === b.id}
        summary="{i + 1}. {t(`admin.block.type.${b.type}` as UiKey)}{b.summary
          ? `: ${b.summary}`
          : ''}"
      >
        <form method="post" action="?/setProps">
          <input type="hidden" name="blockId" value={b.id} />
          <input
            type="hidden"
            name="baseRevisionId"
            value={(mine && form?.blockValues?.baseRevisionId) || data.revision.id}
          />
          <BlockFields
            fields={BLOCK_DEFINITIONS[b.type].fields}
            {values}
            locales={data.docLocales}
            idPrefix="b-{b.id}"
            media={data.media}
            {base}
            upload={data.upload}
            items={data.items}
            invalid={mine ? (form?.fieldIssues ?? []).map((x) => x.name) : []}
            locale={data.locale}
          />
          {#if data.assistEnabled && b.type === 'image' && b.values['p.decorative'] !== 'on'}
            <p class="ui-hint">
              {#each data.docLocales as l (l)}
                <a href={assist({ task: 'alt', block: b.id, locale: l })}
                  >{t('admin.assist.alt')} ({l})</a
                >
              {/each}
            </p>
          {/if}
          {#if data.assistEnabled && b.type === 'rich-text'}
            <p class="ui-hint">
              {#each data.docLocales as l (l)}
                {#each data.docLocales.filter((source: string) => source !== l && !!b.values[`p.content.${source}`]) as source (source)}
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
          <Actions><Button>{t('admin.block.save')}</Button></Actions>
        </form>
        <Actions stack>
          {#each [['up', i > 0], ['down', i < data.blocks.length - 1]] as const as [direction, can] (direction)}
            {#if can}
              <form method="post" action="?/move">
                <input type="hidden" name="blockId" value={b.id} />
                <input type="hidden" name="baseRevisionId" value={data.revision.id} />
                <input type="hidden" name="direction" value={direction} />
                <Button variant="secondary">{t(`admin.block.move.${direction}` as UiKey)}</Button>
              </form>
            {/if}
          {/each}
          <Button
            variant="secondary"
            href="{base}/content/{data.item.id}/blocks/{b.id}/remove?revision={data.revision.id}"
            >{t('admin.block.remove')}</Button
          >
        </Actions>
        {@render insert(b.id, i)}
      </Panel>
    {/each}
    {@render insert(null, -1)}
  </section>

  {#snippet aside()}
    <section aria-labelledby="state">
      <h2 id="state">{t('admin.content.state')}</h2>
      <MetaList
        items={[
          { term: t('admin.content.type.legend'), value: typeName },
          { term: t('admin.content.slug'), value: `/${data.item.slug}` },
        ]}
      />
    </section>

    <section aria-labelledby="publication">
      <h2 id="publication">{t('admin.content.publication.title')}</h2>
      {#if data.restricted}
        <Notice tone="warning" live={false}
          ><p>{t('admin.content.publication.restricted')}</p></Notice
        >
      {/if}
      {#if !data.canPublish}
        <p class="ui-hint">{t('admin.content.publication.readOnly')}</p>
      {/if}
      {#each data.item.publication as p (p.locale)}
        <div class="publication">
          <Card
            id="publication-{p.locale}"
            title="{fill(t('admin.content.publication.locale'), { locale: p.locale })}: {status(p)}"
          >
            <p>
              {#if !p.live}{t('admin.content.publication.notLive')}
              {:else if p.live.latest}{t('admin.content.publication.liveLatest')}
              {:else}{fill(t('admin.content.publication.live'), {
                  when: p.live.when,
                  who: p.live.who,
                })}{/if}
            </p>
            {#if p.pin}
              <p>
                {#if p.pin.revision.latest}
                  {fill(t('admin.content.publication.pinnedLatest'), { at: p.pin.at })}
                {:else}
                  {fill(t('admin.content.publication.pinned'), {
                    when: p.pin.revision.when,
                    at: p.pin.at,
                  })}
                  {t('admin.content.publication.pinnedOlder')}
                {/if}
              </p>
            {/if}
            {#if p.issues.length}
              <p>{t('admin.content.publication.issues')}</p>
              {@render issueList(p.issues)}
            {:else}
              <p>{t('admin.content.publication.ready')}</p>
            {/if}
            {#if data.machineTranslation[p.locale]?.length}
              <Notice tone="warning" live={false}
                ><p>{t('admin.assist.unreviewed')} ({p.locale})</p></Notice
              >
              {#if data.canPublish}
                <form method="post" action="?/approveTranslation" class="translation-approval">
                  <input type="hidden" name="locale" value={p.locale} />
                  <input type="hidden" name="baseRevisionId" value={data.revision.id} />
                  <Actions stack>
                    <Button>{fill(t('admin.assist.approve'), { locale: p.locale })}</Button>
                  </Actions>
                </form>
              {/if}
            {/if}
            {#if data.canPublish}
              <Actions stack>
                {#if p.live?.latest !== true || p.pin}
                  {@render act('publish', p.locale, t('admin.content.publication.publish'))}
                {/if}
                {#if p.pin && !p.pin.revision.latest}
                  {@render act('repin', p.locale, t('admin.content.publication.repin'))}
                {/if}
                {#if p.pin}
                  {@render act('unschedule', p.locale, t('admin.content.publication.unschedule'))}
                {/if}
                {#if p.live}
                  {@render act('unpublish', p.locale, t('admin.content.publication.unpublish'))}
                {/if}
              </Actions>
              <form method="post" action="?/schedule" class="schedule">
                <input type="hidden" name="locale" value={p.locale} />
                <input type="hidden" name="revisionId" value={data.revision.id} />
                <Field
                  id="at.{p.locale}"
                  name="at"
                  type="datetime-local"
                  label={t('admin.content.publication.at')}
                  locale={data.locale}
                  hint="{t('admin.content.publication.zone')} {data.timeZone}"
                  required
                  value={p.pin?.input ?? ''}
                />
                <Actions stack>
                  <Button variant="secondary"
                    >{fill(t('admin.content.publication.schedule'), { locale: p.locale })}</Button
                  >
                </Actions>
              </form>
            {/if}
          </Card>
        </div>
      {/each}
    </section>
  {/snippet}
</EditPage>
