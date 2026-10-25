<!-- Confirm removing one block (TODO #11 B): what goes, and two actions, remove or go back. A
     stale revision is not removed from: the page says who saved in between and links back. -->
<script lang="ts">
  import { fill, ui, type UiKey } from '../../../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const back = $derived(`/admin/${data.tenant.slug}/content/${data.item.id}`);
  const what = $derived(
    `${data.block.position}. ${t(`admin.block.type.${data.block.type}` as UiKey)}${data.block.summary ? `: ${data.block.summary}` : ''}`
  );
</script>

<svelte:head>
  <title
    >{form ? `${t('error.prefix')} ` : ''}{t('admin.block.remove.title')} · {t(
      'admin.title'
    )}</title
  >
</svelte:head>

<main class="page admin">
  <h1>{t('admin.block.remove.title')}</h1>
  {#if form}
    <div class="error-summary" role="alert">
      <h2>{t('error.summary.title')}</h2>
      <p>
        {form.conflict
          ? fill(t('admin.block.remove.conflict'), form.conflict)
          : t(form.error as UiKey)}
      </p>
      <p><a href={back}>{t('admin.content.revisions.back')}</a></p>
    </div>
  {/if}
  <form method="post" class="card">
    <p>{fill(t('admin.block.remove.body'), { what, title: data.item.title })}</p>
    <input type="hidden" name="revision" value={data.revision} />
    <div class="actions">
      <button type="submit">{t('admin.block.remove.confirm')}</button>
      <a class="button secondary" href="{back}?block={data.block.id}#block-{data.block.id}"
        >{t('admin.block.remove.cancel')}</a
      >
    </div>
  </form>
</main>
