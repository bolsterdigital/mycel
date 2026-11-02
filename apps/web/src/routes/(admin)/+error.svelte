<!-- Error pages of the admin: no access (403), login failures (400), login not configured (503),
     too many attempts (429), and everything else, as a system state of the shared components
     (brief #56 § B). Copy from the catalogs (ADR 007). A failed login says in words what the IdP
     answered (brief admin-entry § 7): the callback URL carries the OAuth `error` code, which this
     page reads, so the callback itself stays as it is. Rejected: mapping the codes in the
     callback (it is the auth boundary and would need its own security review for copy).
     A refusal (`refuse`, or `loaded` in lib/server/admin/admin-actions.ts) arrives with a code as
     its message, and a framework error with English; both get their copy from the catalog here. A
     400, 403 or 409 with any other message carries a route's own catalog text, shown as it is.
     The preview routes render this page too. -->
<script lang="ts">
  import { page } from '$app/state';
  import { Button, SystemState } from '#lib/admin/ui/index.js';
  import { FALLBACK_LANG, fill, ui, type UiKey } from '../../i18n/index.js';

  const t = $derived(ui(String(page.data['locale'] ?? FALLBACK_LANG)));
  const email = $derived(String(page.data['email'] ?? ''));
  /** 400, 429 and 503 at the login are about logging in; elsewhere they are not. */
  const atLogin = $derived(/^\/admin\/(login|callback)(\/|$)/.test(page.url.pathname));
  const status = $derived(
    !atLogin && (page.status === 429 || page.status === 503) ? 500 : page.status
  );
  /** The catalog copy for a status or code, or null for a route's own message. */
  const refusal = $derived.by((): UiKey | null => {
    if (atLogin) return null;
    if (status === 404) return 'admin.notFound.body';
    if (status >= 500) return 'admin.error.body';
    if (status === 400 && page.error?.message === 'invalid_input') return 'admin.error.badRequest';
    if (status === 403 && page.error?.message === 'forbidden') return 'admin.forbidden.capability';
    return null;
  });
  /** Someone who is not on this site at all, as opposed to a member whose role does not reach. */
  const notMember = $derived(status === 403 && page.error?.message === 'not_a_member');
  const loginError = $derived(atLogin && (status === 400 || status === 429 || status === 503));
  /** What the IdP said: refused or cancelled, another code, or nothing (a stale attempt). */
  const loginFailure = $derived.by((): UiKey => {
    const code = page.url.searchParams.get('error');
    if (code === 'access_denied') return 'admin.loginFailed.denied';
    if (code) return 'admin.loginFailed.idp';
    return 'admin.loginFailed.body';
  });
  const title = $derived(
    notMember
      ? t('admin.forbidden.title')
      : status === 403
        ? t('admin.forbidden.pageTitle')
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
  {#if notMember}
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
