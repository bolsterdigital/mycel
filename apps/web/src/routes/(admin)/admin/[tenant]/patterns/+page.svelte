<!-- The site's patterns under Library (ADR 012 rule 8): one card per pattern with its type and number
     of blocks, renamed in a fold and deleted with a confirmation in the card. Each card is its own
     form, so a card's buttons post only its pattern, with or without JavaScript. Saving a pattern
     happens on the edit screen ("Save as pattern"); the intro says so.
     Rejected: a table with row actions (a name field does not fit a table row at 320 CSS px). -->
<script lang="ts">
  import {
    Actions,
    Button,
    Card,
    ConfirmAction,
    Field,
    Fieldset,
    Notice,
    OverviewPage,
  } from '#lib/admin/ui/index.js';
  import { fill, refusalCopy, ui } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form && form.done ? form : null);
  const size = (n: number) =>
    fill(t(n === 1 ? 'admin.pattern.manage.blocksOne' : 'admin.pattern.manage.blocksMany'), {
      n: String(n),
    });
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.pattern.manage.title')} · {data.tenant
      .name}</title
  >
</svelte:head>

<OverviewPage
  title={t('admin.pattern.manage.title')}
  locale={data.locale}
  description={t('admin.pattern.manage.intro')}
  listTitle={t('admin.pattern.manage.title')}
  empty={data.patterns.length ? undefined : { title: t('admin.pattern.manage.empty') }}
>
  {#snippet notices()}
    {#if failed}
      <Notice tone="error" title={t('error.summary.title')}><p>{refusalCopy(t, failed)}</p></Notice>
    {/if}
    {#if done}
      <Notice tone="success"><p>{fill(t(done.done), { name: done.name })}</p></Notice>
    {/if}
  {/snippet}
  {#each data.patterns as pattern (pattern.id)}
    <form method="post" action="?/rename" class="ui-card-form">
      <Card title={pattern.name || t('admin.pattern.manage.unnamed')}>
        <p>{t(`admin.content.type.${pattern.type}` as const)} · {size(pattern.blocks)}</p>
        {#if data.write}
          <input type="hidden" name="patternId" value={pattern.id} />
          <input type="hidden" name="locale" value={data.contentLocale} />
          <Fieldset legend={t('admin.pattern.manage.rename')} collapsed>
            <Field
              id="name-{pattern.id}"
              name="name-{pattern.id}"
              label={t('admin.pattern.manage.name')}
              locale={data.locale}
              value={pattern.name}
              maxlength={200}
              autocomplete="off"
            />
            <Actions>
              <Button variant="secondary" formaction="?/rename"
                >{t('admin.pattern.manage.renameSubmit')}</Button
              >
            </Actions>
          </Fieldset>
          <Actions>
            <ConfirmAction
              label={t('admin.pattern.manage.delete')}
              question={t('admin.pattern.manage.deleteQuestion')}
              confirm={t('admin.pattern.manage.deleteConfirm')}
              name={pattern.name}
              formaction="?/delete"
            />
          </Actions>
        {/if}
      </Card>
    </form>
  {/each}
</OverviewPage>
