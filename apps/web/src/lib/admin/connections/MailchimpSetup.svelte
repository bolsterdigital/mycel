<!-- Discovery never echoes a credential. Re-entering it when saving avoids a browser/session
     copy; the server verifies the selected audience belongs to that account before storage. -->
<script lang="ts">
  import { Actions, Button, Field } from '../ui/index.js';
  import { ui } from '../../../i18n/index.js';
  import type { MailchimpAccount } from '@mycel/core';
  let { locale, account }: { locale: string; account: MailchimpAccount | null } = $props();
  const t = $derived(ui(locale));
</script>

<details open={!!account}>
  <summary class="ui-button primary">{t('admin.mailchimp.connect')}</summary>
  <p>{t('admin.mailchimp.setupHelp')}</p>
  <form method="post" action="?/inspect" class="ui-fields">
    <Field
      id="mailchimp-inspect-secret"
      name="secret"
      type="password"
      autocomplete="new-password"
      label={t('admin.mailchimp.apiKey')}
      {locale}
      required
    />
    <Actions><Button>{t('admin.mailchimp.inspect')}</Button></Actions>
  </form>
  {#if account}
    <h3>{account.accountName}</h3>
    <form method="post" action="?/mailchimp" class="ui-fields">
      <Field id="mailchimp-audience" label={t('admin.mailchimp.audience')} {locale}>
        {#snippet control(a)}<select {...a} name="audience" required>
            {#each account.audiences as audience}<option value={audience.id}>{audience.name}</option
              >{/each}
          </select>{/snippet}
      </Field>
      <Field
        id="mailchimp-secret"
        name="secret"
        type="password"
        autocomplete="new-password"
        label={t('admin.mailchimp.apiKey')}
        {locale}
        required
      />
      <Field
        id="mailchimp-owner"
        name="externalOwner"
        label={t('admin.connections.owner')}
        {locale}
        required
      />
      <Field
        id="mailchimp-maintainer"
        name="maintainer"
        label={t('admin.connections.maintainer')}
        {locale}
        required
      />
      <Field
        id="mailchimp-purpose"
        name="purpose"
        label={t('admin.connections.purpose')}
        {locale}
        required
      />
      <Field
        id="mailchimp-scopes"
        name="consentScopes"
        label={t('admin.connections.scopes')}
        {locale}
        required
      />
      <Field id="mailchimp-confirmation" label={t('admin.mailchimp.confirmationOwner')} {locale}>
        {#snippet control(a)}<select {...a} name="confirmationOwner"
            ><option value="mycel">Mycel</option><option value="external">Mailchimp</option></select
          >{/snippet}
      </Field>
      <Actions><Button>{t('admin.mailchimp.save')}</Button></Actions>
    </form>
    {#each account.audiences as audience}
      <details>
        <summary>{audience.name}</summary>
        <ul>
          {#each audience.fields as field}<li>
              <code>{field.tag}</code>: {field.name} ({field.type}{field.required ? ' *' : ''})
            </li>{/each}
        </ul>
      </details>
    {/each}
  {/if}
</details>
