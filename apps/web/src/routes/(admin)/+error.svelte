<!-- Error pages of the admin: no access (403), login failures (400), login not configured (503),
     too many attempts (429), and everything else, as a system state of the shared components
     (brief #56 § B). Copy from the catalogs (ADR 007). -->
<script lang="ts">
  import { page } from '$app/state';
  import { Button, SystemState } from '#lib/admin/ui/index.js';
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

<SystemState kind={status === 403 ? 'forbidden' : 'error'} {title} page>
  {#if status === 403}
    <p>{fill(t('admin.forbidden.body'), { email })}</p>
  {:else if status === 400}
    <p>{t('admin.loginFailed.body')}</p>
  {:else}
    <p>{page.error?.message}</p>
  {/if}
  {#snippet action()}
    {#if status === 400}
      <Button variant="secondary" href="/admin/login">{t('admin.login.again')}</Button>
    {:else}
      <Button variant="secondary" href="/admin">{t('admin.back')}</Button>
    {/if}
  {/snippet}
</SystemState>
