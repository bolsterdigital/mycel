<!-- One asset of the media library (brief #56 § C1) on the detail pattern: preview and lightbox
     (a native <dialog>, no script), the facts as a definition list, the edit form in groups in
     the order a visitor meets them (caption, the work shown, its origin; the focal point folded
     away, skill cms-inrichting) and download and delete as one action group at the end. -->
<script lang="ts">
  import { CREDIT_KINDS, creditKind, pickAny } from '@mycel/core';
  import {
    Actions,
    Button,
    Choices,
    DetailPage,
    Dialog,
    Field,
    Fieldset,
    MetaList,
    Notice,
  } from '#lib/admin/ui/index.js';
  import { formatBytes } from '#lib/admin/format.js';
  import { shortId, withAbsent } from '#lib/admin/people/absent.js';
  import { fill, ui, refusalCopy } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const m = $derived(data.media);
  const size = (n: number) => formatBytes(n, data.locale);
  const pct = (v: number) => Math.round(v * 100);

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form && form.done ? form : null);
  const failure = $derived.by(() => {
    if (!failed) return '';
    const n = 'n' in failed ? Number(failed.n) : 0;
    // One key per plural form; the server names the "other" form.
    const error =
      n === 1 && failed.error === 'admin.media.error.inUse.other'
        ? 'admin.media.error.inUse.one'
        : failed.error;
    return refusalCopy(t, { ...failed, error }, { n, filename: m.filename });
  });
  const titleOf = (item: { title: Record<string, string>; def: string }) =>
    pickAny(item.title, data.locale, item.def) ?? '';
  const facts = $derived([
    { term: t('admin.media.filename'), value: m.filename },
    { term: t('admin.media.type'), value: m.contentType },
    ...(m.width && m.height
      ? [{ term: t('admin.media.dimensions'), value: `${m.width} × ${m.height} px` }]
      : []),
    { term: t('admin.media.size'), value: size(m.sizeBytes) },
    {
      term: t('admin.media.uploaded'),
      value: new Intl.DateTimeFormat(data.locale, { dateStyle: 'long' }).format(
        new Date(m.createdAt)
      ),
    },
    {
      term: t('admin.media.access'),
      value: t(
        m.access === 'restricted' ? 'admin.media.access.restricted' : 'admin.media.access.public'
      ),
    },
    {
      term: t('admin.media.usage'),
      value: fill(t(m.usageCount === 1 ? 'admin.media.usage.one' : 'admin.media.usage.other'), {
        n: m.usageCount,
      }),
    },
    ...(data.usedIn?.items.length
      ? [
          {
            term: t('admin.media.usedIn'),
            value: data.usedIn.more
              ? fill(t('admin.media.usedIn.more'), { n: data.usedIn.items.length })
              : '',
            links: data.usedIn.items.map((item) => ({
              label: titleOf(item),
              href: `${base}/content/${item.id}`,
            })),
          },
        ]
      : []),
  ]);
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{m.filename} · {t('admin.media.title')} · {data.tenant
      .name}</title
  >
</svelte:head>

<DetailPage
  title={m.filename}
  locale={data.locale}
  breadcrumb={[
    { label: data.tenant.name, href: base },
    { label: t('admin.media.title'), href: data.backToList },
    { label: m.filename },
  ]}
  previewLabel={t('admin.media.preview')}
>
  {#snippet notices()}
    {#if failed}
      <Notice tone="error" title={t('error.summary.title')}><p>{failure}</p></Notice>
    {/if}
    {#if done}
      <Notice tone="success">
        <p>{fill(t(done.done), { filename: m.filename })}</p>
      </Notice>
    {/if}
  {/snippet}

  {#snippet preview()}
    {#if data.preview}
      <img
        src={data.preview.src}
        alt=""
        width={data.preview.width ?? undefined}
        height={data.preview.height ?? undefined}
      />
      <Dialog
        id="media-lightbox"
        title={m.filename}
        trigger={t('admin.media.lightbox')}
        locale={data.locale}
        wide
      >
        <img
          src={data.preview.full}
          alt=""
          width={data.preview.width ?? undefined}
          height={data.preview.height ?? undefined}
          loading="lazy"
        />
      </Dialog>
    {:else}
      <p>{t('admin.media.noPreview')}</p>
    {/if}
  {/snippet}

  {#snippet meta()}
    <MetaList items={facts} />
    {#if m.contentType === 'application/pdf'}
      <p class="ui-hint">{t('admin.media.filename.publicHint')}</p>
    {/if}
  {/snippet}

  <form method="post" action="?/update" aria-labelledby="media-edit">
    <h2 id="media-edit">{t('admin.media.edit')}</h2>
    {#if data.locales.length}
      <Fieldset legend={t('admin.media.group.caption')}>
        {#each data.locales as locale (locale)}
          <Field
            id="caption-{locale}"
            name="caption.{locale}"
            label={fill(t('admin.media.field.caption'), { locale })}
            locale={data.locale}
            maxlength={1000}
            lang={locale}
            value={m.caption[locale] ?? ''}
          />
        {/each}
      </Fieldset>
    {/if}
    <Fieldset legend={t('admin.media.field.work')}>
      <Field
        id="work-title"
        name="work.title"
        label={t('admin.media.field.workTitle')}
        locale={data.locale}
        maxlength={300}
        value={m.credit.work?.title ?? ''}
      />
      <Field
        id="work-maker"
        name="work.maker"
        label={t('admin.media.field.workMaker')}
        locale={data.locale}
        maxlength={300}
        value={m.credit.work?.maker ?? ''}
      />
    </Fieldset>
    <Fieldset legend={t('admin.media.group.origin')}>
      <Choices
        id="kind"
        name="kind"
        legend={t('admin.media.field.kind')}
        locale={data.locale}
        hint={t('admin.media.field.kind.hint')}
        selected={[creditKind(m.credit)]}
        options={CREDIT_KINDS.map((k) => ({ value: k, label: t(`admin.block.option.${k}`) }))}
      />
      {#if data.people}
        <Choices
          id="photographer-person"
          name="photographerPersonId"
          legend={t('admin.block.field.photographerPersonId')}
          locale={data.locale}
          searchable
          selected={[m.credit.photographerPersonId ?? '']}
          options={[
            { value: '', label: t('admin.block.none') },
            ...withAbsent(
              data.people.map((person) => ({ value: person.id, label: person.name })),
              (o) => o.value,
              [m.credit.photographerPersonId],
              (id) => ({ value: id, label: fill(t('admin.people.absent'), { id: shortId(id) }) })
            ),
          ]}
        />
      {:else}
        <input
          type="hidden"
          name="photographerPersonId"
          value={m.credit.photographerPersonId ?? ''}
        />
      {/if}
      <Field
        id="photographer"
        name="photographer"
        label={t('admin.media.field.photographer')}
        locale={data.locale}
        maxlength={300}
        value={m.credit.photographer ?? ''}
      />
      <Field
        id="source"
        name="source"
        label={t('admin.media.field.source')}
        locale={data.locale}
        maxlength={500}
        value={m.source ?? ''}
      />
      <Field
        id="licence"
        name="licence"
        label={t('admin.media.field.licence')}
        locale={data.locale}
        maxlength={100}
        value={m.licence ?? ''}
      />
    </Fieldset>
    {#if m.kind === 'image'}
      <Fieldset
        legend={t('admin.media.field.focal')}
        hint={`${t('admin.media.field.focalHint')} ${fill(t('admin.media.field.focalNow'), {
          x: pct(m.focal.x),
          y: pct(m.focal.y),
        })}`}
        collapsed
      >
        <Field
          id="focal-x"
          name="focal.x"
          type="number"
          label={t('admin.media.field.focalX')}
          locale={data.locale}
          min="0"
          max="1"
          step="0.01"
          required
          value={m.focal.x}
        />
        <Field
          id="focal-y"
          name="focal.y"
          type="number"
          label={t('admin.media.field.focalY')}
          locale={data.locale}
          min="0"
          max="1"
          step="0.01"
          required
          value={m.focal.y}
        />
      </Fieldset>
    {:else}
      <input type="hidden" name="focal.x" value={m.focal.x} />
      <input type="hidden" name="focal.y" value={m.focal.y} />
    {/if}
    <Choices
      id="access"
      name="access"
      legend={t('admin.media.access')}
      locale={data.locale}
      hint={t('admin.media.access.hint')}
      selected={[m.access]}
      options={[
        { value: 'public', label: t('admin.media.access.public') },
        { value: 'restricted', label: t('admin.media.access.restricted') },
      ]}
    />
    <Actions><Button>{t('admin.media.save')}</Button></Actions>
  </form>

  {#snippet footer()}
    <form method="post" action="?/delete">
      <Actions>
        <Button variant="secondary" href={data.original} download>
          {t(m.kind === 'image' ? 'admin.media.download.original' : 'admin.media.download.file')}
        </Button>
        <Button variant="danger">{t('admin.media.delete')}</Button>
      </Actions>
    </form>
  {/snippet}
</DetailPage>
