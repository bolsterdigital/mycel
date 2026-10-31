<!-- Error pages of the admin: no access (403), login failures (400), login not configured (503),
     too many attempts (429), and everything else, as a system state of the shared components
     (brief #56 § B). Copy from the catalogs (ADR 007). A failed login says in words what the IdP
     answered (brief admin-entry § 7): the callback URL carries the OAuth `error` code, which this
     page reads, so the callback itself stays as it is. Rejected: mapping the codes in the
     callback (it is the auth boundary and would need its own security review for copy). -->
<script lang="ts">
  import { page } from '$app/state';
  import { Button, SystemState } from '#lib/admin/ui/index.js';
  import { fill, ui, type UiKey } from '../../i18n/index.js';

  const t = $derived(ui(String(page.data['locale'] ?? 'en')));
  const email = $derived(String(page.data['email'] ?? ''));
  /** 429 and 503 at the login are about logging in; elsewhere they keep their own message. */
  const atLogin = $derived(/^\/admin\/(login|callback)(\/|$)/.test(page.url.pathname));
  const status = $derived(
    !atLogin && (page.status === 429 || page.status === 503) ? 500 : page.status
  );
  /** What the IdP said: refused or cancelled, another code, or nothing (a stale attempt). */
  const loginFailure = $derived.by((): UiKey => {
    const code = page.url.searchParams.get('error');
    if (code === 'access_denied') return 'admin.loginFailed.denied';
    if (code) return 'admin.loginFailed.idp';
    return 'admin.loginFailed.body';
  });
  const title = $derived(
    status === 403
      ? t('admin.forbidden.title')
      : status === 404
        ? t('admin.notFound.title')
        : status === 400 || status === 429 || status === 503
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
    <p>{t(loginFailure)}</p>
  {:else if status === 429}
    <p>{t('admin.login.tooMany')}</p>
  {:else if status === 503}
    <p>{t('admin.login.notConfigured')}</p>
  {:else}
    <p>{page.error?.message}</p>
  {/if}
  {#snippet action()}
    {#if status === 400 || status === 429}
      <Button variant="secondary" href="/admin/login">{t('admin.login.retry')}</Button>
    {:else}
      <Button variant="secondary" href="/admin">{t('admin.back')}</Button>
    {/if}
  {/snippet}
</SystemState>
