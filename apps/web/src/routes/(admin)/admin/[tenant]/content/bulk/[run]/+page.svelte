<!-- Preview and receipts are distinct columns: the historical dry run is never shown as
     success. Shared table and action primitives retain native no-JS and narrow-screen behaviour. -->
<script lang="ts">
  import { Actions, Button, Notice, OverviewPage, Table } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const phase = $derived(data.report.undoRequested ? 'undo' : 'apply');
  const started = $derived(data.report.items.some((i) => i.apply !== null));
  type State =
    | NonNullable<PageProps['data']['report']['items'][number]['apply']>['status']
    | PageProps['data']['plan']['items'][number]['preview']['status']
    | 'pending';
  const columns = ['item', 'operation', 'preview', 'apply', 'undo'] as const;
  const label = (s: State) => t(`admin.content.bulk.state.${s}` as const);
</script>

<svelte:head><title>{t('admin.content.bulk.title')} · {data.tenant.name}</title></svelte:head>
<OverviewPage
  locale={data.locale}
  title={t('admin.content.bulk.title')}
  listTitle={t('admin.content.bulk.results')}
  breadcrumb={[
    { label: data.tenant.name, href: `/admin/${data.tenant.slug}` },
    { label: t('admin.content.bulk.title') },
  ]}
>
  {#snippet notices()}
    {#if form}<Notice tone="error"><p>{t(form.error)}</p></Notice>{/if}
  {/snippet}
  <p>
    {fill(t('admin.content.bulk.summary'), { n: data.plan.items.length, locale: data.plan.locale })}
  </p>
  <p>{t('admin.content.bulk.bookmark')}</p>
  <p>
    {t(
      data.report.undoRequested
        ? 'admin.content.bulk.undoWarning'
        : 'admin.content.bulk.confirmWarning'
    )}
  </p>
  <Table
    id="bulk-results"
    caption={t('admin.content.bulk.results')}
    stack
    hideCaption
    columns={columns.map((key) => ({
      key,
      label: t(`admin.content.bulk.column.${key}` as const),
    }))}
  >
    {#snippet rows()}
      {#each data.plan.items as slot, ordinal}
        {@const receipt = data.report.items[ordinal]}
        <tr>
          <th scope="row"
            ><a href="/admin/{data.tenant.slug}/content/{slot.selection.itemId}"
              >{slot.preview.candidate?.title[data.plan.locale] ||
                slot.preview.candidate?.title[slot.preview.candidate?.defaultLocale ?? ''] ||
                t('admin.content.untitled')}</a
            ></th
          >
          <td data-label={t('admin.content.bulk.column.operation')}
            >{t(`admin.content.bulk.operation.${slot.selection.operation.kind}` as const)}
            {#if slot.selection.operation.kind === 'save' && slot.preview.candidate?.type === 'article'}
              <p>
                {t('admin.content.bulk.section')}: {slot.preview.candidate.sectionId
                  ? data.sections[slot.preview.candidate.sectionId]
                  : t('admin.content.bulk.noSection')}
              </p>
            {/if}
          </td>
          <td data-label={t('admin.content.bulk.column.preview')}
            >{label(slot.preview.status)}
            {#each slot.preview.problems as problem}<p>
                {t(`admin.content.bulk.problem.${problem.code}` as const)}
              </p>{/each}
          </td>
          {#each ['apply', 'undo'] as const as p}
            {@const result = p === 'apply' ? receipt?.apply : receipt?.undo}
            <td data-label={t(`admin.content.bulk.column.${p}` as const)}
              >{label(result?.status ?? 'pending')}
              {#if result?.retryable}<p>{t('admin.content.bulk.retryable')}</p>{/if}
              {#each result?.problems ?? [] as problem}<p>
                  {t(`admin.content.bulk.problem.${problem.code}` as const)}
                </p>{/each}
            </td>
          {/each}
        </tr>
      {/each}
    {/snippet}
  </Table>
  <Actions stack>
    {#if data.canAct && data.next !== null}
      <form method="POST" action={data.step}>
        <input type="hidden" name="version" value={data.plan.version} />
        <input type="hidden" name="ordinal" value={data.next} />
        <input type="hidden" name="phase" value={phase} />
        <Button
          >{t(
            data.report.undoRequested
              ? 'admin.content.bulk.undoNext'
              : started
                ? 'admin.content.bulk.next'
                : 'admin.content.bulk.confirm'
          )}</Button
        >
      </form>
    {/if}
    {#if data.canAct && started && !data.report.undoRequested}
      <form method="POST" action={data.step}>
        <input type="hidden" name="version" value={data.plan.version} />
        <input type="hidden" name="ordinal" value="0" />
        <input type="hidden" name="phase" value="undo" />
        <Button variant="secondary">{t('admin.content.bulk.undo')}</Button>
      </form>
    {/if}
    <Button variant="link" href={data.back}>{t('admin.content.bulk.back')}</Button>
  </Actions>
</OverviewPage>
