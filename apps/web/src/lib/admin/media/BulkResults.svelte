<!-- What a bulk action on media did, one line per file: a partial result stays visible
     and says why, so "try again" is an informed choice. -->
<script lang="ts">
  import { Table } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../i18n/index.js';

  type Result = { id: string; filename: string; status: string; usageCount?: number | undefined };
  let {
    id,
    results,
    locale,
  }: {
    id: string;
    results: readonly Result[];
    locale: string;
  } = $props();
  const t = $derived(ui(locale));
  const label = (r: Result) =>
    r.status === 'in-use'
      ? fill(t('admin.media.bulk.status.in-use'), { n: r.usageCount ?? 0 })
      : t(
          `admin.media.bulk.status.${r.status as 'deleted' | 'not-found' | 'restored' | 'expired' | 'over-limit'}` as const
        );
</script>

<Table
  {id}
  stack
  caption={t('admin.media.bulk.results')}
  columns={[
    { key: 'name', label: t('admin.media.filename') },
    { key: 'status', label: t('admin.media.bulk.result') },
  ]}
>
  {#snippet rows()}
    {#each results as r (r.id)}
      <tr>
        <th scope="row">{r.filename}</th>
        <td data-label={t('admin.media.bulk.result')}>{label(r)}</td>
      </tr>
    {/each}
  {/snippet}
</Table>
