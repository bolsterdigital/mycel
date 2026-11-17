<!-- Connect the site's Mollie account for donations (MY-252 PR 3): one API key, stored encrypted
     as a `mollie` connection and switched on at once; the key is never shown again. Only offered
     while the site has no live Mollie connection, so a second key is a replacement on that
     connection's own page, not a second account. -->
<script lang="ts">
  import { Actions, Button, Field } from '../ui/index.js';
  import { ui } from '../../../i18n/index.js';
  let { locale, owner }: { locale: string; owner: string } = $props();
  const t = $derived(ui(locale));
</script>

<details>
  <summary class="ui-button secondary">{t('admin.mollie.connect')}</summary>
  <p>{t('admin.mollie.setupHelp')}</p>
  <form method="post" action="?/mollie" class="ui-fields">
    <Field
      id="mollie-secret"
      name="secret"
      type="password"
      autocomplete="new-password"
      label={t('admin.mollie.apiKey')}
      hint={t('admin.mollie.apiKeyHint')}
      {locale}
      required
    />
    <Field
      id="mollie-owner"
      name="externalOwner"
      label={t('admin.connections.owner')}
      value={owner}
      {locale}
      required
      maxlength={160}
    />
    <Actions><Button>{t('admin.mollie.save')}</Button></Actions>
  </form>
</details>
