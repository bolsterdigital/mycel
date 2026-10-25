<!-- The export page of a site (TODO #28): what an archive holds and how long it stays, one button to
     ask for one (a native form post), and the earlier archives with a download link for a ready
     one. Each archive is a card with its facts as a term list (term above value, so 200% text
     never squeezes a column) and its one action in an `.actions` group that wraps whole; the
     ask button stands alone. e2e/export.spec.ts checks 320 CSS px and 200% text (skill
     ui-action-layout). -->
<script lang="ts">
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const when = $derived(
    new Intl.DateTimeFormat(data.locale, { dateStyle: 'medium', timeStyle: 'short' })
  );
  const at = (iso: string) => when.format(new Date(iso));
  const size = $derived(new Intl.NumberFormat(data.locale, { maximumFractionDigits: 1 }));
  const bytes = (n: number) =>
    n >= 1024 ** 3
      ? `${size.format(n / 1024 ** 3)} GB`
      : n >= 1024 ** 2
        ? `${size.format(n / 1024 ** 2)} MB`
        : `${size.format(Math.max(n / 1024, 0.1))} kB`;
  const STATUS: Record<string, UiKey> = {
    queued: 'admin.export.status.queued',
    running: 'admin.export.status.running',
    ready: 'admin.export.status.ready',
    failed: 'admin.export.status.failed',
    expired: 'admin.export.status.expired',
  };
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.export.title')} · {data.tenant.name}</title
  >
</svelte:head>

<main class="page admin">
  <h1>{t('admin.export.title')}</h1>
  <p>
    <a href="/admin/{data.tenant.slug}"
      >{fill(t('admin.status.back'), { name: data.tenant.name })}</a
    >
  </p>

  {#if failed}
    <div class="error-summary" role="alert">
      <h2>{t('error.summary.title')}</h2>
      <p>{t(failed.error as UiKey)}</p>
    </div>
  {/if}
  {#if done}
    <div class="notice" role="status">
      <p>{t(done.done as UiKey)}</p>
    </div>
  {/if}

  <section aria-labelledby="request">
    <h2 id="request">{t('admin.export.request.title')}</h2>
    <p>{t('admin.export.intro.contents')}</p>
    <p>{fill(t('admin.export.intro.lifetime'), { days: data.retentionDays })}</p>
    <form method="post" action="?/request">
      <button type="submit">{t('admin.export.request.button')}</button>
    </form>
  </section>

  <section aria-labelledby="archives">
    <h2 id="archives">{t('admin.export.list.title')}</h2>
    {#if data.exports.length === 0}
      <p>{t('admin.export.list.none')}</p>
    {:else}
      <p class="muted">{t('admin.export.list.reload')}</p>
    {/if}
    {#each data.exports as item (item.id)}
      <article class="card" aria-labelledby="export-{item.id}">
        <h3 id="export-{item.id}">
          {fill(t('admin.export.item'), { time: at(item.requestedAt) })}
        </h3>
        <dl>
          <dt>{t('admin.export.field.status')}</dt>
          <dd>{t(STATUS[item.status] ?? 'admin.export.status.queued')}</dd>
          <dt>{t('admin.export.field.by')}</dt>
          <dd><code>{item.requestedBy}</code></dd>
          {#if item.sizeBytes !== null}
            <dt>{t('admin.export.field.size')}</dt>
            <dd>{bytes(item.sizeBytes)}</dd>
          {/if}
          {#if item.status === 'ready' && item.expiresAt}
            <dt>{t('admin.export.field.expires')}</dt>
            <dd><time datetime={item.expiresAt}>{at(item.expiresAt)}</time></dd>
          {/if}
          {#if item.sha256}
            <dt>{t('admin.export.field.sha256')}</dt>
            <dd><code>{item.sha256}</code></dd>
          {/if}
          {#if item.error}
            <dt>{t('admin.export.field.error')}</dt>
            <dd>{item.error}</dd>
          {/if}
        </dl>
        {#if item.href}
          <div class="actions">
            <a class="button" href={item.href} download>{t('admin.export.download')}</a>
          </div>
        {:else if item.status === 'expired'}
          <p>{t('admin.export.expired')}</p>
        {/if}
      </article>
    {/each}
  </section>
</main>
