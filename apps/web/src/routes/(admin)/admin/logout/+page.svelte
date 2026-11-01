<!-- Logging out (brief admin-entry § 8): the admin's menu posts here, so the page itself only
     shows a button for someone who typed the address. After the post, or when no one is signed
     in, it lands on "You are logged out" as a system state and says what it did not do: the
     Dreamkit ID session stays (no RP-initiated logout, +page.server.ts), so logging in again may
     not ask for a password. Logged out, session-restore.js removes any editor input this tab
     kept for after a login. -->
<script lang="ts">
  import AdminScript from '#lib/admin/trusted/AdminScript.svelte';
  import { Button, SystemState } from '#lib/admin/ui/index.js';
  import { ui } from '../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const done = $derived(!!form?.loggedOut || !data.signedIn);
</script>

<svelte:head>
  <title>{done ? t('admin.loggedOut.title') : t('admin.logout')} · {t('admin.title')}</title>
  {#if done}<AdminScript src="/_admin/session-restore.js" />{/if}
</svelte:head>

{#if done}
  <SystemState kind="signed-out" title={t('admin.loggedOut.title')} page>
    <p data-restore-clear>{t('admin.loggedOut.body')}</p>
    <p class="ui-hint">{t('admin.loggedOut.idp')}</p>
    {#snippet action()}
      <Button href="/admin/login">{t('admin.login.again')}</Button>
    {/snippet}
  </SystemState>
{:else}
  <SystemState kind="signed-out" title={t('admin.logout')} page>
    {#snippet action()}
      <form method="post">
        <Button>{t('admin.logout')}</Button>
      </form>
    {/snippet}
  </SystemState>
{/if}
