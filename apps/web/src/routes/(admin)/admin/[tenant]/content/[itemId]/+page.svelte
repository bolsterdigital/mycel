<!-- The edit page of one item (TODO #11 A1): its status per locale, the document fields as one
     native form, links to the revisions and to a preview per locale in a new tab. A failed save
     comes back with what was typed; a conflict also shows who saved in between and what changed
     (ADR 018 rule 2). The action group wraps whole buttons and links onto a new line when they
     do not fit (skill ui-action-layout).
     Each block (§ B) is a native <details>, open for the block just edited: its fields as one
     form, then five actions: save, move up, move down, remove (a confirmation page) and insert
     a block before or after it (a page with the new block's fields). The move and remove actions
     stand in one column on a narrow card, like the publication actions.
     The publication panel (§ A2) has one card per locale: what is live, what is pinned, what stops
     a publish, and up to four actions, each its own form. They stack into a column when the card
     is narrow, so no label is ever cut (skill ui-action-layout); the restricted notice comes
     before every button and cannot be closed (ADR 018 rule 6). -->
<script lang="ts">
  import BlockFields from '#lib/admin/BlockFields.svelte';
  import Diff from '#lib/admin/Diff.svelte';
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
  const baseRevision = $derived(v('baseRevisionId') || data.revision.id);
  /** A field name of a block form as words: the field's label, plus its locale. */
  const fieldLabel = (name: string): string => {
    const parts = name.split('.').slice(1);
    const locale = data.docLocales.includes(parts.at(-1) ?? '') ? parts.pop() : null;
    const key = [...parts].reverse().find((p) => !/^\d+$/.test(p) && p !== 'mode');
    const label = key ? t(`admin.block.field.${key}` as UiKey) : t('admin.block.title');
    return locale ? `${label} (${locale})` : label;
  };
  const fieldId = (blockId: string, name: string) => `b-${blockId}-${name.replaceAll('.', '-')}`;
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

{#snippet issueList(issues: { path: string; field: string | null; copy: string }[])}
  <ul>
    {#each issues as i (i.path + i.copy)}
      <li>
        {#if i.field}<a href="#{i.field}">{i.path}</a>{:else}{i.path}{/if}: {t(i.copy as UiKey)}
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet act(action: string, locale: string, label: string, at?: string)}
  <form method="post" action="?/{action}">
    <input type="hidden" name="locale" value={locale} />
    <input type="hidden" name="revisionId" value={data.revision.id} />
    {#if at}<input type="hidden" name="at" value={at} />{/if}
    <button type="submit" class={action === 'unpublish' ? 'secondary' : ''}
      >{fill(label, { locale })}</button
    >
  </form>
{/snippet}

{#snippet area(name: string, label: string, max: number)}
  <div class="field">
    <label for={name}>{label}</label>
    <textarea id={name} {name} maxlength={max} rows="3">{v(name)}</textarea>
  </div>
{/snippet}

<main class="page admin">
  <h1>{title}</h1>
  <p><a href="{base}/content?type={data.item.type}">{t('admin.content.title')}</a></p>

  {#if form && !form.conflict}
    <div class="error-summary" role="alert">
      <h2>{t('error.summary.title')}</h2>
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
        <p>{fill(t('admin.content.publication.error.refused'), { locale: form.locale ?? '' })}</p>
        {@render issueList(form.issues ?? [])}
      {:else}
        <p>{t(form.error as UiKey)}</p>
      {/if}
    </div>
  {/if}
  {#if data.done}
    <div class="notice" role="status"><p>{fill(t(data.done), { locale: data.doneLocale })}</p></div>
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
    <p>{fill(t('admin.content.edit.revision'), data.revision)}</p>
    <p><a href="{base}/content/{data.item.id}/revisions">{t('admin.content.revisions')}</a></p>
  </section>

  <section aria-labelledby="publication">
    <h2 id="publication">{t('admin.content.publication.title')}</h2>
    {#if data.restricted}
      <p class="notice">{t('admin.content.publication.restricted')}</p>
    {/if}
    {#if !data.canPublish}
      <p class="muted">{t('admin.content.publication.readOnly')}</p>
    {/if}
    {#each data.item.publication as p (p.locale)}
      <section class="card publication" aria-labelledby="publication-{p.locale}">
        <h3 id="publication-{p.locale}">
          {fill(t('admin.content.publication.locale'), { locale: p.locale })}:
          {t(`admin.content.status.${p.status}` as UiKey)}{#if p.changes}, {t(
              'admin.content.status.changes'
            )}{/if}
        </h3>
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
        {#if data.canPublish}
          <div class="actions stack">
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
          </div>
          <form method="post" action="?/schedule" class="schedule">
            <input type="hidden" name="locale" value={p.locale} />
            <input type="hidden" name="revisionId" value={data.revision.id} />
            <div class="field">
              <label for="at.{p.locale}">{t('admin.content.publication.at')}</label>
              <p class="muted" id="zone-{p.locale}">
                {t('admin.content.publication.zone')}
                {data.timeZone.split('/')[0]}/<wbr />{data.timeZone.split('/').slice(1).join('/')}
              </p>
              <input
                id="at.{p.locale}"
                name="at"
                aria-describedby="zone-{p.locale}"
                type="datetime-local"
                required
                value={p.pin?.input ?? ''}
              />
            </div>
            <button type="submit"
              >{fill(t('admin.content.publication.schedule'), { locale: p.locale })}</button
            >
          </form>
        {/if}
      </section>
    {/each}
  </section>

  <form method="post" action="?/save" class="card" data-live-preview-source>
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
        <fieldset id="authors">
          <legend>{t('admin.content.field.authors')}</legend>
          {#if authors.length === 0}<p class="muted">
              {t('admin.content.edit.noAuthors')}
            </p>{/if}
          {#each authors as a (a.id)}
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
            {#each sections as s (s.id)}
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

  {#if !article && data.canWrite}
    <section
      class="card live-preview"
      data-live-preview
      data-item-id={data.item.id}
      data-preview-action="{base}/preview/draft"
      hidden
      aria-labelledby="live-preview-title"
    >
      <h2 id="live-preview-title">{t('admin.content.preview.live')}</h2>
      <div class="field">
        <label for="live-preview-locale">{t('admin.content.preview.locale')}</label>
        <select id="live-preview-locale" data-live-preview-locale>
          {#each data.docLocales as l (l)}<option value={l}>{l}</option>{/each}
        </select>
      </div>
      <iframe
        name="mycel-live-preview"
        title={t('admin.content.preview.live')}
        data-live-preview-frame
      ></iframe>
      <p class="muted">{t('admin.content.preview.keyboard')}</p>
    </section>
    <script type="module" src="/_admin/live-preview-parent.js"></script>
  {/if}

  <section aria-labelledby="blocks">
    <h2 id="blocks">{t('admin.block.title')}</h2>
    {#if article}
      <p><a href="{base}/content/{data.item.id}/write">{t('admin.editor.title')}</a></p>
    {/if}
    {#if data.blocks.length === 0}<p>{t('admin.block.empty')}</p>{/if}
    {#each data.blocks as b, i (b.id)}
      {@const mine = form?.blockId === b.id}
      {@const values = (mine && form?.blockValues) || b.values}
      <details class="card block" id="block-{b.id}" open={mine || data.openBlock === b.id}>
        <summary
          >{i + 1}. {t(`admin.block.type.${b.type}` as UiKey)}{#if b.summary}: {b.summary}{/if}</summary
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
            items={data.items}
            invalid={mine ? (form?.fieldIssues ?? []).map((x) => x.name) : []}
            locale={data.locale}
          />
          <div class="actions">
            <button type="submit">{t('admin.block.save')}</button>
          </div>
        </form>
        <div class="actions stack">
          {#each [['up', i > 0], ['down', i < data.blocks.length - 1]] as const as [direction, can] (direction)}
            {#if can}
              <form method="post" action="?/move">
                <input type="hidden" name="blockId" value={b.id} />
                <input type="hidden" name="baseRevisionId" value={data.revision.id} />
                <input type="hidden" name="direction" value={direction} />
                <button type="submit" class="secondary"
                  >{t(`admin.block.move.${direction}` as UiKey)}</button
                >
              </form>
            {/if}
          {/each}
          <a
            class="button secondary"
            href="{base}/content/{data.item.id}/blocks/{b.id}/remove?revision={data.revision.id}"
            >{t('admin.block.remove')}</a
          >
        </div>
        {@render insert(b.id, i)}
      </details>
    {/each}
    {@render insert(null, -1)}
  </section>
</main>

{#snippet insert(anchor: string | null, i: number)}
  <form method="get" action="{base}/content/{data.item.id}/blocks/new" class="insert">
    <input type="hidden" name="revision" value={data.revision.id} />
    {#if anchor}<input type="hidden" name="anchor" value={anchor} />{/if}
    <fieldset>
      <legend
        >{anchor
          ? fill(t('admin.block.insert.near'), { n: i + 1 })
          : t('admin.block.insert.document')}</legend
      >
      <div class="field">
        <label for="type-{anchor ?? 'doc'}">{t('admin.block.insert.type')}</label>
        <select id="type-{anchor ?? 'doc'}" name="type">
          {#each data.blockTypes as type (type)}
            <option value={type}>{t(`admin.block.type.${type}` as UiKey)}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label for="place-{anchor ?? 'doc'}">{t('admin.block.insert.place')}</label>
        <select id="place-{anchor ?? 'doc'}" name="place">
          {#each anchor ? ['after', 'before'] : ['end', 'start'] as place (place)}
            <option value={place}>{t(`admin.block.place.${place}` as UiKey)}</option>
          {/each}
        </select>
      </div>
      <div class="actions">
        <button type="submit" class="secondary">{t('admin.block.insert.go')}</button>
      </div>
    </fieldset>
  </form>
{/snippet}
