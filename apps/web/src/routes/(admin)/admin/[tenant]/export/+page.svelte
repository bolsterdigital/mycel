<!-- The export page of a site (TODO #28, brief admin-operations-screens § 7) on the shared admin
     components: what an archive holds and how long it stays with the one button to ask for one
     (a native form post); the archive being built, with its step in words and a refresh link;
     the newest ready archive with its download, the checksum behind "Technical details"; and
     the history as a table that stacks below 36rem, who asked by name. Nothing polls: a reload
     shows the progress. No cancel, because the export state machine has none (#74).
     e2e/export.spec.ts checks the flow and 320 CSS px and 200% text (skill ui-action-layout).
     Rejected: a card per archive (the reader scans a history, #82) and a progress bar (the job
     reports steps, not a fraction; a bar would invent one). -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    MetaList,
    Notice,
    PageHeader,
    Table,
  } from '#lib/admin/ui/index.js';
  import { actorLabel } from '#lib/admin/audit-words.js';
  import { formatBytes, formatWhen } from '#lib/admin/format.js';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);

  const now = $derived(new Date(data.now));
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
  const who = (ref: string) => {
    const [kind, id] = ref.split(/:(.*)/s) as [string, string | undefined];
    return actorLabel(t, { actorKind: kind, actorId: id ?? null }, data.names);
  };

  type Item = (typeof data.exports)[number];
  const TONE: Record<string, 'neutral' | 'info' | 'success' | 'error'> = {
    queued: 'neutral',
    running: 'info',
    ready: 'success',
    failed: 'error',
    expired: 'neutral',
  };
  const STATUS: Record<string, UiKey> = {
    queued: 'admin.export.status.queued',
    running: 'admin.export.status.running',
    ready: 'admin.export.status.ready',
    failed: 'admin.export.status.failed',
    expired: 'admin.export.status.expired',
  };
  const status = (item: Item) => t(STATUS[item.status] ?? 'admin.export.status.queued');

  /** The archive being built: the newest that is queued or running. */
  const building = $derived(
    data.exports.find((e) => e.status === 'queued' || e.status === 'running') ?? null
  );
  const latest = $derived(data.exports.find((e) => e.status === 'ready') ?? null);
  const details = (item: Item) => [
    ...(item.sha256 ? [{ term: t('admin.export.field.sha256'), value: item.sha256 }] : []),
    ...(item.schemaVersion
      ? [{ term: t('admin.export.field.schema'), value: item.schemaVersion }]
      : []),
  ];
  /** What the history says beside the status: until when, why it failed, or that it is gone. */
  const note = (item: Item) =>
    item.status === 'ready' && item.expiresAt
      ? fill(t('admin.export.until'), { time: when(item.expiresAt).text })
      : item.status === 'failed' && item.error
        ? item.error
        : item.status === 'expired'
          ? t('admin.export.expired')
          : '';
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.export.title')} · {data.tenant.name}</title
  >
</svelte:head>

<main class="page admin">
  <PageHeader
    title={t('admin.export.title')}
    locale={data.locale}
    breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.export.title') }]}
  />

  {#if failed}
    <Notice tone="error" title={t('error.summary.title')}><p>{t(failed.error as UiKey)}</p></Notice>
  {/if}
  {#if done}
    <Notice tone="success"><p>{t(done.done as UiKey)}</p></Notice>
  {/if}

  <section aria-labelledby="request">
    <h2 id="request">{t('admin.export.request.title')}</h2>
    <p>{t('admin.export.intro.contents')}</p>
    <p>{fill(t('admin.export.intro.lifetime'), { days: data.retentionDays })}</p>
    <form method="post" action="?/request">
      <Actions><Button>{t('admin.export.request.button')}</Button></Actions>
    </form>
  </section>

  {#if building}
    {@const asked = when(building.requestedAt)}
    <Notice tone="info" live={false} title={t('admin.export.building.title')}>
      <p>
        {fill(t('admin.export.building.step'), {
          step: building.status === 'queued' ? 1 : 2,
          status: status(building),
        })}
        {t('admin.export.building.asked')}
        <time datetime={asked.iso} title={asked.full}>{asked.text}</time>
        · {who(building.requestedBy)}
      </p>
      <p>{t('admin.export.building.next')}</p>
      <Actions>
        <Button variant="secondary" href="{base}/export">{t('admin.export.refresh')}</Button>
      </Actions>
    </Notice>
  {/if}

  {#if latest?.href}
    {@const made = when(latest.finishedAt ?? latest.requestedAt)}
    <section aria-labelledby="latest">
      <h2 id="latest">{t('admin.export.latest.title')}</h2>
      <p>
        {t('admin.export.latest.made')}
        <time datetime={made.iso} title={made.full}>{made.text}</time
        >{#if latest.sizeBytes !== null}
          · {formatBytes(latest.sizeBytes, data.locale)}{/if}{#if latest.expiresAt}
          · {fill(t('admin.export.until'), { time: when(latest.expiresAt).text })}{/if}
      </p>
      <Actions>
        <Button href={latest.href} download>{t('admin.export.download')}</Button>
      </Actions>
      {#if details(latest).length}
        <details class="ui-fold">
          <summary>{t('admin.export.details')}</summary>
          <MetaList items={details(latest)} />
        </details>
      {/if}
    </section>
  {/if}

  <section aria-labelledby="archives">
    <h2 id="archives">{t('admin.export.list.title')}</h2>
    {#if data.exports.length === 0}
      <p>{t('admin.export.list.none')}</p>
    {:else}
      <Table
        id="export-table"
        caption={t('admin.export.list.title')}
        hideCaption
        stack
        columns={[
          { key: 'asked', label: t('admin.export.col.asked') },
          { key: 'by', label: t('admin.export.field.by') },
          { key: 'status', label: t('admin.export.field.status') },
          { key: 'size', label: t('admin.export.field.size'), numeric: true },
          { key: 'note', label: t('admin.export.col.note') },
        ]}
      >
        {#snippet rows()}
          {#each data.exports as item (item.id)}
            {@const asked = when(item.requestedAt)}
            <tr data-export={item.id}>
              <td data-label={t('admin.export.col.asked')}
                ><time datetime={asked.iso} title={asked.full}>{asked.text}</time></td
              >
              <td data-label={t('admin.export.field.by')}>{who(item.requestedBy)}</td>
              <td data-label={t('admin.export.field.status')}
                ><Badge tone={TONE[item.status] ?? 'neutral'}>{status(item)}</Badge></td
              >
              <td data-label={t('admin.export.field.size')} class="numeric"
                >{item.sizeBytes !== null ? formatBytes(item.sizeBytes, data.locale) : ''}</td
              >
              <td data-label={t('admin.export.col.note')}>
                {note(item)}
                {#if item.href && item.id !== latest?.id}
                  <a href={item.href} download
                    >{t('admin.export.download')}<span class="ui-visually-hidden">
                      · {asked.full}</span
                    ></a
                  >
                {/if}
              </td>
            </tr>
          {/each}
        {/snippet}
      </Table>
    {/if}
  </section>
</main>
