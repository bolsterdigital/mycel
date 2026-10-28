<!-- Confirm removing one block (TODO #11 B): what goes, and two actions, remove or go back. A
     stale revision is not removed from: the page says who saved in between and links back. On
     the shared page header and action group (brief #56 § C2); removing is the danger action. -->
<script lang="ts">
  import { Actions, Button, Notice, PageHeader } from '#lib/admin/ui/index.js';
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
  <PageHeader
    title={t('admin.block.remove.title')}
    locale={data.locale}
    breadcrumb={[
      { label: data.tenant.name, href: `/admin/${data.tenant.slug}` },
      {
        label: t(
          data.item.type === 'page' ? 'admin.content.filter.page' : 'admin.content.filter.article'
        ),
        href: `/admin/${data.tenant.slug}/content?type=${data.item.type}`,
      },
      { label: data.item.title, href: back },
      { label: t('admin.block.remove.title') },
    ]}
  />
  {#if form}
    <Notice tone="error" title={t('error.summary.title')}>
      <p>
        {form.conflict
          ? fill(t('admin.block.remove.conflict'), form.conflict)
          : t(form.error as UiKey)}
      </p>
      <p><a href={back}>{t('admin.content.revisions.back')}</a></p>
    </Notice>
  {/if}
  <form method="post" class="ui-section">
    <p>{fill(t('admin.block.remove.body'), { what, title: data.item.title })}</p>
    <input type="hidden" name="revision" value={data.revision} />
    <Actions>
      <Button variant="danger">{t('admin.block.remove.confirm')}</Button>
      <Button variant="secondary" href="{back}?block={data.block.id}#block-{data.block.id}"
        >{t('admin.block.remove.cancel')}</Button
      >
    </Actions>
  </form>
</main>
