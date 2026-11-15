<!-- One version of the navigation: what it says about itself (current draft, live where), what it
     shows visitors in the content locale, and, for an older version, the restore that makes it the
     draft again, behind a confirmation. Restoring publishes nothing; the screen says so. -->
<script lang="ts">
  import NavigationPreview from '#lib/admin/navigation/NavigationPreview.svelte';
  import { formatWhen } from '#lib/admin/format.js';
  import { Actions, ConfirmAction, Notice, PageHeader, Section } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/navigation`);
  const when = $derived(
    data.createdAt
      ? formatWhen(data.createdAt, {
          locale: data.locale,
          zone: data.timeZone,
          relative: data.dateFormat !== 'absolute',
        }).text
      : data.revisionId.slice(0, 8)
  );
  const title = $derived(fill(t('admin.navigation.revision.title'), { when }));
</script>

<svelte:head>
  <title>{title} · {t('admin.navigation.title')} · {data.tenant.name}</title>
</svelte:head>

<main class="page admin ui-overview">
  <PageHeader
    {title}
    locale={data.locale}
    breadcrumb={[
      { label: data.tenant.name, href: `/admin/${data.tenant.slug}` },
      { label: t('admin.navigation.title'), href: base },
      { label: t('admin.navigation.revisions'), href: `${base}/revisions` },
      { label: title },
    ]}
    description={fill(t('admin.navigation.revision.intro'), { locale: data.contentLocale })}
  />
  {#if form?.error}<Notice tone="error">{t(form.error)}</Notice>{/if}
  {#if data.current || data.liveIn.length}
    <p>
      {#if data.current}{t('admin.navigation.revision.isCurrent')}{/if}
      {#if data.liveIn.length}{fill(t('admin.navigation.revision.liveIn'), {
          locales: data.liveIn.join(', '),
        })}.{/if}
    </p>
  {/if}

  <NavigationPreview id="version" preview={data.preview} menus={data.menus} locale={data.locale} />

  {#if data.canWrite && !data.current}
    <Section id="navigation-restore" title={t('admin.navigation.restore')} locale={data.locale}>
      <form id="navigation-restore-form" method="post">
        <input type="hidden" name="revisionId" value={data.revisionId} />
        <input type="hidden" name="baseRevisionId" value={data.baseRevisionId ?? ''} />
      </form>
      <Actions>
        <ConfirmAction
          label={t('admin.navigation.restore')}
          question={t('admin.navigation.restore.question')}
          confirm={t('admin.navigation.restore.confirm')}
          name={title}
          form="navigation-restore-form"
          formaction="?/restore"
        />
      </Actions>
    </Section>
  {/if}
</main>
