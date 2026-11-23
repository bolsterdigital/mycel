<!-- Video is a media-library view. Upload metadata stays in Mycel and Tus carries the file. -->
<script lang="ts">
  import AdminScript from '#lib/admin/trusted/AdminScript.svelte';
  import { pick } from '@mycel/core';
  import {
    Actions,
    Button,
    Field,
    Fieldset,
    Notice,
    PageHeader,
    Select,
  } from '#lib/admin/ui/index.js';
  import { ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/media`);
  const canStart = $derived(data.canUpload && data.posters.length > 0);
</script>

<svelte:head>
  <title>{t('admin.video.title')} · {data.tenant.name}</title>
</svelte:head>

<main class="page admin">
  <PageHeader
    title={t('admin.video.title')}
    locale={data.locale}
    breadcrumb={[{ label: t('admin.media.title'), href: base }, { label: t('admin.video.title') }]}
  />
  {#if form && !form.ok}<Notice title={t('error.summary.title')} tone="error"
      ><p>{t('admin.video.actionFailed')}</p></Notice
    >{/if}
  {#if canStart}
    <noscript><p>{t('admin.video.scriptRequired')}</p></noscript>
    <form
      hidden
      data-video-upload
      data-endpoint="{base}/video/upload"
      data-failed={t('admin.video.failed')}
      data-storage={t('admin.video.storage')}
      data-working={t('admin.video.working')}
      data-encoding={t('admin.video.state.encoding')}
    >
      <Fieldset legend={t('admin.video.upload')}>
        <Field
          id="video-file"
          name="file"
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          label={t('admin.video.file')}
          locale={data.locale}
          required
        />
        {#each data.tenant.locales as locale (locale)}
          <Field
            id="video-title-{locale}"
            name="title.{locale}"
            label="{t('admin.video.recordingTitle')} ({locale})"
            maxlength={200}
            locale={data.locale}
            required={locale === data.tenant.defaultLocale}
          />
        {/each}
        <Field
          id="video-maker"
          name="maker"
          label={t('admin.video.maker')}
          maxlength={300}
          locale={data.locale}
          required
        />
        <Select
          id="video-licence"
          name="licence"
          label={t('admin.video.licence')}
          locale={data.locale}
          options={data.licences.map((value) => ({ value, label: t(`block.licence.${value}`) }))}
          required
        />
        <Select
          id="video-poster"
          name="poster"
          label={t('admin.video.poster')}
          locale={data.locale}
          options={data.posters}
          required
        />
        <Field
          id="video-watch"
          name="watch"
          type="url"
          label={t('admin.video.watch')}
          locale={data.locale}
        />
        <Actions><Button type="submit">{t('admin.video.upload')}</Button></Actions>
        <p role="status" data-video-status></p>
      </Fieldset>
    </form>
  {:else if data.canUpload}
    <p>{t('admin.video.posterRequired')}</p>
  {/if}
  {#if data.videos.length}
    <ul>
      {#each data.videos as video (video.id)}
        <li>
          <strong
            >{pick(video.metadata.title, data.locale, data.tenant.defaultLocale) ??
              video.id}</strong
          >
          <p>{t(`admin.video.state.${video.state}`)}</p>
          {#if data.canWrite}
            <form method="POST">
              <input type="hidden" name="id" value={video.id} />
              <Actions>
                {#if data.canUpload && video.state !== 'unbound'}
                  <Button variant="secondary" formaction="?/check">{t('admin.video.check')}</Button>
                {/if}
                <Button variant="secondary" formaction="?/trash">{t('admin.video.trash')}</Button>
              </Actions>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p>{t('admin.video.empty')}</p>
  {/if}
</main>

{#if canStart}
  <AdminScript src="/_admin/video-tus.js" classic />
  <AdminScript src="/_admin/video-upload.js" classic />
{/if}
