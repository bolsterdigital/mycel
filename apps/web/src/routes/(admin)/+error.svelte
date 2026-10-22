<!-- Error pages of the admin: no access (403), login failures (400), login not configured (503),
     too many attempts (429), and everything else. Copy from the catalogs (ADR 007). -->
<script lang="ts">
  import { page } from '$app/state';
  import { fill, ui } from '../../i18n/index.js';

  const t = $derived(ui(String(page.data['locale'] ?? 'en')));
  const email = $derived(String(page.data['email'] ?? ''));
  const status = $derived(page.status);
  const title = $derived(
    status === 403
      ? t('admin.forbidden.title')
      : status === 404
        ? t('admin.notFound.title')
        : status === 400
          ? t('admin.loginFailed.title')
          : t('admin.error.title')
  );
</script>

<svelte:head>
  <title>{title} · {t('admin.title')}</title>
</svelte:head>

<main class="page admin">
  <h1>{title}</h1>
  {#if status === 403}
    <p>{fill(t('admin.forbidden.body'), { email })}</p>
    <p><a href="/admin">{t('admin.back')}</a></p>
  {:else if status === 400}
    <p>{t('admin.loginFailed.body')}</p>
    <p><a href="/admin/login">{t('admin.login.again')}</a></p>
  {:else}
    <p>{page.error?.message}</p>
    <p><a href="/admin">{t('admin.back')}</a></p>
  {/if}
</main>
