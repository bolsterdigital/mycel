<!-- The log of a site (brief admin-operations-screens § 5): who did what, when and how it ended,
     in words (audit-words.ts), newest first. Filters are a GET form above the list, so every
     view is a URL and works without JavaScript; "Older actions" follows the cursor. A row is a
     record, not a figure, so the table stacks below 36rem instead of scrolling sideways. An
     operation the catalogue has no words for shows its technical name in code. -->
<script lang="ts">
  import {
    Actions,
    Button,
    Field,
    Notice,
    OverviewPage,
    Select,
    Table,
  } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { actorKindKey, actorLabel, operationKey, resultKey } from '#lib/admin/audit-words.js';
  import { ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);

  const now = $derived(new Date(data.now));
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });

  const names = $derived(
    Object.fromEntries([
      ...data.members.map((m) => [`operator:${m.id}`, m.name]),
      ...data.keys.flatMap((k) => [
        [`api-key:${k.id}`, k.name],
        [`agent:${k.id}`, k.name],
      ]),
    ])
  );

  const operationOptions = $derived([
    { value: '', label: t('admin.audit.filter.any') },
    ...data.operations
      .map((op) => ({ value: op, label: t(operationKey(op)!) }))
      .sort((a, b) => a.label.localeCompare(b.label, data.locale)),
  ]);
  const actorOptions = $derived([
    { value: '', label: t('admin.audit.filter.any') },
    ...data.members.map((m) => ({ value: `operator:${m.id}`, label: m.name })),
    ...data.keys.map((k) => ({
      value: `api-key:${k.id}`,
      label: `${t('admin.audit.actor.api-key')}: ${k.name}`,
    })),
    ...(['system', 'anonymous', 'platform'] as const).map((kind) => ({
      value: kind,
      label: t(actorKindKey(kind)),
    })),
  ]);
</script>

<svelte:head>
  <title>{t('admin.audit.title')} · {data.tenant.name}</title>
</svelte:head>

<OverviewPage
  title={t('admin.audit.title')}
  locale={data.locale}
  breadcrumb={[
    { label: data.tenant.name, href: base },
    { label: t('admin.status.title'), href: `${base}/status` },
    { label: t('admin.audit.title') },
  ]}
  description={t('admin.audit.lead')}
  listTitle={t('admin.audit.list')}
  empty={data.items.length === 0
    ? { title: t(data.filtered ? 'admin.audit.none' : 'admin.audit.empty') }
    : undefined}
  paging={data.older ? { next: data.older } : undefined}
>
  {#snippet notices()}
    {#if data.invalidDate}
      <Notice tone="warning"><p>{t('admin.audit.filter.invalid')}</p></Notice>
    {/if}
  {/snippet}

  {#snippet filters()}
    <form method="get" class="ui-filter-bar" aria-label={t('admin.audit.filter.label')}>
      <Field
        id="audit-from"
        name="from"
        type="date"
        size="s"
        value={data.filter.from}
        label={t('admin.audit.filter.from')}
        locale={data.locale}
      />
      <Field
        id="audit-to"
        name="to"
        type="date"
        size="s"
        value={data.filter.to}
        label={t('admin.audit.filter.to')}
        locale={data.locale}
      />
      <Select
        id="audit-operation"
        name="operation"
        size="m"
        value={data.filter.operation}
        options={operationOptions}
        label={t('admin.audit.filter.operation')}
        locale={data.locale}
      />
      <Select
        id="audit-actor"
        name="actor"
        size="m"
        value={data.filter.actor}
        options={actorOptions}
        label={t('admin.audit.filter.actor')}
        locale={data.locale}
      />
      <Actions>
        <Button variant="secondary">{t('admin.audit.filter.submit')}</Button>
        {#if data.filtered}
          <Button variant="link" href="?">{t('admin.audit.filter.clear')}</Button>
        {/if}
        {#if data.newest}
          <Button variant="link" href={data.newest}>{t('admin.audit.newest')}</Button>
        {/if}
      </Actions>
    </form>
  {/snippet}

  <Table
    id="audit-table"
    caption={t('admin.audit.list')}
    hideCaption
    stack
    card
    columns={[
      { key: 'when', label: t('admin.audit.col.when') },
      { key: 'actor', label: t('admin.audit.col.actor') },
      { key: 'operation', label: t('admin.audit.col.operation') },
      { key: 'result', label: t('admin.audit.col.result') },
    ]}
  >
    {#snippet rows()}
      {#each data.items as row (row.id)}
        {@const at = when(row.occurredAt)}
        {@const words = operationKey(row.operation)}
        <tr>
          <td data-label={t('admin.audit.col.when')}
            ><time datetime={at.iso} title={at.full}>{at.text}</time></td
          >
          <td data-label={t('admin.audit.col.actor')}>{actorLabel(t, row, names)}</td>
          <td data-label={t('admin.audit.col.operation')}
            >{#if words}{t(words)}{:else}<code>{row.operation}</code>{/if}</td
          >
          <td data-label={t('admin.audit.col.result')}>{t(resultKey(row.result))}</td>
        </tr>
      {/each}
    {/snippet}
  </Table>
</OverviewPage>
