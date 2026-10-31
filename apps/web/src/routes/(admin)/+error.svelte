<!-- Error pages of the admin: no access (403), login failures (400), login not configured (503),
     too many attempts (429), and everything else, as a system state of the shared components
     (brief #56 § B). Copy from the catalogs (ADR 007). A failed login says in words what the IdP
     answered (brief admin-entry § 7): the callback URL carries the OAuth `error` code, which this
     page reads, so the callback itself stays as it is. Rejected: mapping the codes in the
     callback (it is the auth boundary and would need its own security review for copy).
     A refusal in a page load (`loaded` in lib/server/admin/admin-actions.ts) arrives as 403, 404 or 400 with the use-case
     code as its message; such a code gets its copy from the catalog, any other message (a route's
     own catalog text) is shown as it is. -->
<script lang="ts">
  import { page } from '$app/state';
  import { Button, SystemState } from '#lib/admin/ui/index.js';
  import { fill, ui, type UiKey } from '../../i18n/index.js';

  const t = $derived(ui(String(page.data['locale'] ?? 'en')));
  const email = $derived(String(page.data['email'] ?? ''));
  /** 400, 429 and 503 at the login are about logging in; elsewhere they are not. */
  const atLogin = $derived(/^\/admin\/(login|callback)(\/|$)/.test(page.url.pathname));
  const status = $derived(
    !atLogin && (page.status === 429 || page.status === 503) ? 500 : page.status
  );
  /** The catalog copy for a use-case code from `loaded`, or null for a route's own message. */
  const refusal = $derived.by((): UiKey | null => {
    const message = page.error?.message;
    if (status === 404 && message === 'not_found') return 'admin.notFound.body';
    if (status === 400 && message === 'invalid_input') return 'admin.error.badRequest';
    return null;
  });
  /** A member whose role lacks a capability, as opposed to someone who is not a member. */
  const lacksCapability = $derived(status === 403 && page.error?.message === 'forbidden');
  const loginError = $derived(atLogin && (status === 400 || status === 429 || status === 503));
  /** What the IdP said: refused or cancelled, another code, or nothing (a stale attempt). */
  const loginFailure = $derived.by((): UiKey => {
    const code = page.url.searchParams.get('error');
    if (code === 'access_denied') return 'admin.loginFailed.denied';
    if (code) return 'admin.loginFailed.idp';
    return 'admin.loginFailed.body';
  });
  const title = $derived(
    lacksCapability
      ? t('admin.forbidden.pageTitle')
      : status === 403
        ? t('admin.forbidden.title')
        : status === 404
          ? t('admin.notFound.title')
          : loginError
            ? t('admin.loginFailed.title')
            : t('admin.error.title')
  );
</script>

<svelte:head>
  <title>{title} · {t('admin.title')}</title>
</svelte:head>

<SystemState kind={status === 403 ? 'forbidden' : 'error'} {title} page>
  {#if lacksCapability}
    <p>{t('admin.forbidden.capability')}</p>
  {:else if status === 403}
    <p>{fill(t('admin.forbidden.body'), { email })}</p>
  {:else if refusal}
    <p>{t(refusal)}</p>
  {:else if loginError && status === 400}
    <p>{t(loginFailure)}</p>
  {:else if loginError && status === 429}
    <p>{t('admin.login.tooMany')}</p>
  {:else if loginError && status === 503}
    <p>{t('admin.login.notConfigured')}</p>
  {:else}
    <p>{page.error?.message}</p>
  {/if}
  {#snippet action()}
    {#if atLogin && (status === 400 || status === 429)}
      <Button variant="secondary" href="/admin/login">{t('admin.login.retry')}</Button>
    {:else}
      <Button variant="secondary" href="/admin">{t('admin.back')}</Button>
    {/if}
  {/snippet}
</SystemState>
