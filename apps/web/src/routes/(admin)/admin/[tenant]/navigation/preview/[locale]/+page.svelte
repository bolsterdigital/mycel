<!-- The preview of the draft navigation in one locale, then its publication: first what is left
     out and whether that blocks publishing, then the placements as visitors would get them, then
     the controls. The publish button posts the revision shown here; taking the locale offline asks
     first. Both are native form posts. Without the right to publish, the screen says so instead
     of offering a control that would be refused. -->
<script lang="ts">
  import '#lib/admin/navigation/menu-list.css';
  import { page } from '$app/state';
  import NavigationPreview from '#lib/admin/navigation/NavigationPreview.svelte';
  import { formatWhen } from '#lib/admin/format.js';
  import {
    Actions,
    Badge,
    Button,
    ConfirmAction,
    Notice,
    PageHeader,
    Section,
  } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/navigation`);
  const locale = $derived(data.previewLocale);
  const title = $derived(fill(t('admin.navigation.preview.title'), { locale }));
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      relative: data.dateFormat !== 'absolute',
    });
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
      { label: title },
    ]}
    description={fill(t('admin.navigation.preview.intro'), { locale })}
  />
  {#if form?.error}<Notice tone="error">{t(form.error)}</Notice
    >{:else if page.url.searchParams.has('published')}<Notice tone="success"
      >{fill(t('admin.navigation.overview.published'), { locale })}</Notice
    >{:else if page.url.searchParams.has('offline')}<Notice tone="success"
      >{fill(t('admin.navigation.overview.offline'), { locale })}</Notice
    >{/if}

  <Section
    id="navigation-problems"
    title={t('admin.navigation.problems')}
    intro={fill(t('admin.navigation.problems.intro'), { locale })}
    locale={data.locale}
  >
    {#if data.problems.length}
      <ul class="ui-menu-list">
        {#each data.problems as problem, i (i)}
          <li class="ui-menu-item">
            <p class="ui-menu-item-label">
              {fill(t('admin.navigation.problem.where'), {
                item: problem.item ?? t('admin.navigation.noLabel'),
                menu: problem.menu,
              })}
              {#if problem.blocking}<Badge tone="warning"
                  >{t('admin.navigation.problem.blocking')}</Badge
                >{/if}
            </p>
            <p class="ui-menu-item-facts">
              {fill(t(`admin.navigation.problem.${problem.code}`), { locale })}
            </p>
          </li>
        {/each}
      </ul>
    {:else}
      <p>{t('admin.navigation.problems.none')}</p>
    {/if}
  </Section>

  <NavigationPreview id="preview" preview={data.preview} menus={data.menus} locale={data.locale} />

  <Section id="navigation-publish" title={t('admin.navigation.publication')} locale={data.locale}>
    <p>
      {#if data.live}{@const w = when(data.live.publishedAt)}{fill(
          t('admin.navigation.preview.live'),
          { locale, when: w.text }
        )}{:else}{fill(t('admin.navigation.preview.notLive'), { locale })}{/if}
      {t(data.ahead ? 'admin.navigation.preview.ahead' : 'admin.navigation.preview.same')}
    </p>
    {#if !data.canPublish}
      <p>{t('admin.navigation.publish.noRight')}</p>
    {:else}
      <form id="navigation-publication" method="post">
        <input type="hidden" name="revisionId" value={data.revisionId ?? ''} />
      </form>
      <Actions>
        {#if data.revisionId && data.ahead && !data.blocked}
          <Button form="navigation-publication" formaction="?/publish"
            >{fill(t('admin.navigation.publish'), { locale })}</Button
          >
        {/if}
        {#if data.live}
          <ConfirmAction
            label={fill(t('admin.navigation.unpublish'), { locale })}
            question={t('admin.navigation.unpublish.question')}
            confirm={t('admin.navigation.unpublish.confirm')}
            form="navigation-publication"
            formaction="?/unpublish"
          />
        {/if}
      </Actions>
    {/if}
  </Section>
</main>
