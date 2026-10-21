<!-- Who is logged in, and the way out. A native form post: logout works without JavaScript. -->
<script lang="ts">
  import { fill, ui } from '../../i18n/index.js';

  let { locale, email }: { locale: string; email: string } = $props();
  const t = $derived(ui(locale));
</script>

<header class="admin-header">
  <p>{fill(t('admin.signedInAs'), { email })}</p>
  <form method="post" action="/admin/logout">
    <button type="submit" class="secondary">{t('admin.logout')}</button>
  </form>
</header>
