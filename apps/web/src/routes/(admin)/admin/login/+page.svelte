<!-- The page before the IdP (brief admin-entry § 1-2, 9): the product, why you are here when an
     admin page sent you, which host you log in at, and one button. The button is a link with
     `start` and the path to return to, so it works without JavaScript; +page.server.ts then does
     the redirect it always did. Not a form: the admin's CSP `form-action 'self'` also covers the
     redirect to the IdP that follows a form submission, and the browser would stop there. Without
     a configured issuer it says so instead of offering a button that would fail. Language follows
     the browser until the operator chooses one. Sent here by an admin page, it loads
     session-restore.js, which marks the editor input that post carried as not arrived, so the
     edit screen can put it back after the login. -->
<script lang="ts">
  import { Button, SystemState } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
</script>

<svelte:head>
  <title>{t('admin.login.title')} · {t('admin.title')}</title>
  {#if data.sentHere}<script type="module" src="/_admin/session-restore.js"></script>{/if}
</svelte:head>

<SystemState kind="signed-out" title={t('admin.login.title')} page>
  {#if data.sentHere}
    <p data-restore-return={data.returnTo}>{t('admin.login.reason.return')}</p>
  {/if}
  {#if data.idp}
    <p>{fill(t('admin.login.how'), { idp: data.idp })}</p>
  {:else}
    <p>{t('admin.login.notConfigured')}</p>
  {/if}
  {#snippet action()}
    {#if data.idp}
      <Button href={data.start}>{t('admin.login.submit')}</Button>
    {/if}
  {/snippet}
</SystemState>
