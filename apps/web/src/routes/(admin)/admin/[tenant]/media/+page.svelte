<!-- The media library of a site (TODO #10b): upload, list, edit and delete, every action a native
     form post and the edit form behind a native <details>, so nothing needs JavaScript. Each
     asset's action group (download original, delete) wraps whole controls onto a new line when
     they do not fit, and a long label wraps inside its own control at word boundaries (skill
     ui-action-layout); e2e/media.spec.ts checks 320 CSS px and 200% text. -->
<script lang="ts">
  import Header from '#lib/admin/Header.svelte';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const size = (n: number) => {
    const [unit, d] =
      n >= 1024 ** 3
        ? (['gigabyte', 1024 ** 3] as const)
        : n >= 1024 ** 2
          ? (['megabyte', 1024 ** 2] as const)
          : (['kilobyte', 1024] as const);
    return new Intl.NumberFormat(data.locale, {
      style: 'unit',
      unit,
      maximumFractionDigits: 1,
    }).format(n / d);
  };
  const filenameOf = (f: Record<string, unknown>) =>
    typeof f.filename === 'string' ? f.filename : '';
  const failure = $derived.by(() => {
    if (!failed) return '';
    const n = 'n' in failed ? Number(failed.n) : 0;
    // One key per plural form; the server names the "other" form.
    const key = (
      n === 1 && failed.error === 'admin.media.error.inUse.other'
        ? 'admin.media.error.inUse.one'
        : failed.error
    ) as UiKey;
    const copy = t(key);
    return fill(copy, {
      what: 'what' in failed && failed.what ? t(failed.what as UiKey) : '',
      n,
      filename: filenameOf(failed),
      max: size(data.maxUploadBytes),
    });
  });
  const pct = (v: number) => Math.round(v * 100);
</script>

<svelte:head>
  <title>{failed ? `${t('error.prefix')} ` : ''}{t('admin.media.title')} · {data.tenant.name}</title
  >
</svelte:head>

<Header locale={data.locale} email={data.email} />
<main class="page admin">
  <h1>{t('admin.media.title')}</h1>
  <p>
    <a href="/admin/{data.tenant.slug}">{fill(t('admin.media.back'), { name: data.tenant.name })}</a
    >
  </p>

  {#if failed}
    <div class="error-summary" role="alert">
      <h2>{t('error.summary.title')}</h2>
      <p>{failure}</p>
    </div>
  {/if}
  {#if done}
    <div class="notice" role="status">
      <p>{fill(t(done.done as UiKey), { filename: filenameOf(done) })}</p>
    </div>
  {/if}

  {#if data.storage}
    <p>
      {fill(t('admin.media.storage'), {
        used: size(data.storage.usedBytes),
        max: size(data.storage.maxBytes),
      })}
    </p>
  {/if}

  <form method="post" action="?/upload" enctype="multipart/form-data" class="card">
    <h2>{t('admin.media.upload.title')}</h2>
    <div class="field">
      <label for="upload-file">{t('admin.media.upload.file')}</label>
      <input
        id="upload-file"
        name="file"
        type="file"
        required
        accept="image/jpeg,image/png,image/webp,image/avif,image/gif,application/pdf"
        aria-describedby="upload-hint"
      />
    </div>
    <p class="muted" id="upload-hint">
      {fill(t('admin.media.upload.hint'), { max: size(data.maxUploadBytes) })}
    </p>
    <div class="check field">
      <input id="upload-restricted" name="access" type="checkbox" value="restricted" />
      <label for="upload-restricted">{t('admin.media.upload.restricted')}</label>
    </div>
    <div class="actions">
      <button type="submit">{t('admin.media.upload.submit')}</button>
    </div>
  </form>

  <section aria-labelledby="library">
    <h2 id="library">{t('admin.media.library')}</h2>
    {#if data.items.length === 0}
      <p>{t('admin.media.none')}</p>
    {/if}
    {#each data.items as m (m.id)}
      <article class="card media-item" aria-labelledby="m-{m.id}">
        <div class="media-head">
          {#if m.thumb}
            <img
              src={m.thumb}
              alt=""
              width="160"
              height={m.width && m.height ? Math.round((160 * m.height) / m.width) : 160}
              loading="lazy"
            />
          {/if}
          <div>
            <h3 id="m-{m.id}">{m.filename}</h3>
            <dl>
              <dt>{t('admin.media.size')}</dt>
              <dd>
                {size(m.sizeBytes)}{#if m.width && m.height}, {m.width} × {m.height} px{/if}
              </dd>
              <dt>{t('admin.media.usage')}</dt>
              <dd>
                {fill(t(m.usageCount === 1 ? 'admin.media.usage.one' : 'admin.media.usage.other'), {
                  n: m.usageCount,
                })}
              </dd>
              <dt>{t('admin.media.access')}</dt>
              <dd>
                {t(
                  m.access === 'restricted'
                    ? 'admin.media.access.restricted'
                    : 'admin.media.access.public'
                )}
              </dd>
            </dl>
          </div>
        </div>

        <details>
          <summary>{t('admin.media.edit')}</summary>
          <form method="post" action="?/update" class="edit">
            <input type="hidden" name="id" value={m.id} />
            {#each data.locales as locale (locale)}
              <div class="field">
                <label for="caption-{m.id}-{locale}">
                  {fill(t('admin.media.field.caption'), { locale })}
                </label>
                <input
                  id="caption-{m.id}-{locale}"
                  name="caption.{locale}"
                  type="text"
                  maxlength="1000"
                  lang={locale}
                  value={m.caption[locale] ?? ''}
                />
              </div>
            {/each}
            <fieldset>
              <legend>{t('admin.media.field.work')}</legend>
              <div class="field">
                <label for="work-title-{m.id}">{t('admin.media.field.workTitle')}</label>
                <input
                  id="work-title-{m.id}"
                  name="work.title"
                  type="text"
                  maxlength="300"
                  value={m.credit.work?.title ?? ''}
                />
              </div>
              <div class="field">
                <label for="work-maker-{m.id}">{t('admin.media.field.workMaker')}</label>
                <input
                  id="work-maker-{m.id}"
                  name="work.maker"
                  type="text"
                  maxlength="300"
                  value={m.credit.work?.maker ?? ''}
                />
              </div>
            </fieldset>
            <div class="field">
              <label for="photographer-{m.id}">{t('admin.media.field.photographer')}</label>
              <input
                id="photographer-{m.id}"
                name="photographer"
                type="text"
                maxlength="300"
                value={m.credit.photographer ?? ''}
              />
            </div>
            <div class="field">
              <label for="source-{m.id}">{t('admin.media.field.source')}</label>
              <input
                id="source-{m.id}"
                name="source"
                type="text"
                maxlength="500"
                value={m.source ?? ''}
              />
            </div>
            <div class="field">
              <label for="licence-{m.id}">{t('admin.media.field.licence')}</label>
              <input
                id="licence-{m.id}"
                name="licence"
                type="text"
                maxlength="100"
                value={m.licence ?? ''}
              />
            </div>
            {#if m.kind === 'image'}
              <fieldset>
                <legend>{t('admin.media.field.focal')}</legend>
                <p class="muted">{t('admin.media.field.focalHint')}</p>
                <div class="field">
                  <label for="focal-x-{m.id}">{t('admin.media.field.focalX')}</label>
                  <input
                    id="focal-x-{m.id}"
                    name="focal.x"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    required
                    value={m.focal.x}
                  />
                </div>
                <div class="field">
                  <label for="focal-y-{m.id}">{t('admin.media.field.focalY')}</label>
                  <input
                    id="focal-y-{m.id}"
                    name="focal.y"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    required
                    value={m.focal.y}
                  />
                </div>
                <p class="muted">
                  {fill(t('admin.media.field.focalNow'), { x: pct(m.focal.x), y: pct(m.focal.y) })}
                </p>
              </fieldset>
            {:else}
              <input type="hidden" name="focal.x" value={m.focal.x} />
              <input type="hidden" name="focal.y" value={m.focal.y} />
            {/if}
            <fieldset>
              <legend>{t('admin.media.access')}</legend>
              <div class="check field">
                <input
                  id="access-public-{m.id}"
                  name="access"
                  type="radio"
                  value="public"
                  checked={m.access === 'public'}
                />
                <label for="access-public-{m.id}">{t('admin.media.access.public')}</label>
              </div>
              <div class="check field">
                <input
                  id="access-restricted-{m.id}"
                  name="access"
                  type="radio"
                  value="restricted"
                  checked={m.access === 'restricted'}
                />
                <label for="access-restricted-{m.id}">{t('admin.media.access.restricted')}</label>
              </div>
              <p class="muted">{t('admin.media.access.hint')}</p>
            </fieldset>
            <div class="actions">
              <button type="submit">{t('admin.media.save')}</button>
            </div>
          </form>
        </details>

        <form method="post" action="?/delete" class="actions">
          <input type="hidden" name="id" value={m.id} />
          <input type="hidden" name="filename" value={m.filename} />
          <a class="button secondary" href={m.original} download>
            {t(m.kind === 'image' ? 'admin.media.download.original' : 'admin.media.download.file')}
          </a>
          <button type="submit" class="secondary">
            {t('admin.media.delete')}
          </button>
        </form>
      </article>
    {/each}
    {#if data.nextCursor}
      <p><a href="?cursor={data.nextCursor}">{t('admin.media.more')}</a></p>
    {/if}
  </section>
</main>
