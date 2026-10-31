<!-- Settings, API access (#101): the site's API keys, moved from Members because members are
     people. Creating a key happens in a dialog with the role picker without
     Administrator (a key never holds tenant:admin); its token is shown once, in KeyReveal, in the
     response to the post that made it. Each key is a card with its role, prefix and dates, and
     revoking asks in the card. The forms post to the site settings page with `?section=api`, so
     the answer shows this section again. -->
<script lang="ts">
  import type { ApiKeyView, Role } from '@mycel/core';
  import {
    Actions,
    Badge,
    Button,
    Card,
    ConfirmAction,
    Dialog,
    Field,
    KeyReveal,
    Notice,
    RolePicker,
    SettingsSection,
  } from '#lib/admin/ui/index.js';
  import { fill, ui, type UiKey } from '../../i18n/index.js';

  let {
    keys,
    roles,
    capabilities,
    locale,
    form,
  }: {
    keys: readonly ApiKeyView[];
    roles: readonly Role[];
    capabilities: readonly string[];
    locale: string;
    form: Record<string, unknown> | null | undefined;
  } = $props();

  const t = $derived(ui(locale));
  const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : null);
  const failed = $derived(form && typeof form.error === 'string' ? form : null);
  const revoked = $derived(form?.action === 'revokeKey' && 'done' in form);
  const token = $derived(
    form && typeof form.token === 'string'
      ? { token: form.token, name: String(form.keyName ?? '') }
      : null
  );
</script>

{#if failed}
  <Notice tone="error" title={t('error.summary.title')}>
    <p>
      {typeof failed.what === 'string'
        ? fill(t(failed.error as UiKey), { what: t(failed.what as UiKey) })
        : t(failed.error as UiKey)}
    </p>
  </Notice>
{/if}
{#if revoked}
  <Notice tone="success"><p>{t('admin.done.revoked')}</p></Notice>
{/if}
{#if token}
  <KeyReveal
    id="new-key"
    title="{t('admin.keys.token.title')}: {token.name}"
    value={token.token}
    {locale}
  >
    <p>{t('admin.keys.token.body')}</p>
  </KeyReveal>
{/if}

<SettingsSection id="site-api" title={t('admin.access.title')}>
  <p>{t('admin.access.intro')}</p>
  <Actions>
    <Dialog
      id="create-key"
      title={t('admin.keys.create.title')}
      trigger={t('admin.keys.create.title')}
      variant="primary"
      {locale}
    >
      <form method="post" action="?section=api&/createKey" class="ui-fields">
        <Field
          id="key-name"
          size="m"
          name="name"
          type="text"
          required
          maxlength={100}
          label={t('admin.keys.create.name')}
          {locale}
        />
        <RolePicker id="key" {locale} {roles} {capabilities} />
        <p class="ui-hint">{t('admin.keys.create.hint')}</p>
        <Actions>
          <Button>{t('admin.keys.create.submit')}</Button>
        </Actions>
      </form>
    </Dialog>
  </Actions>
  {#if keys.length === 0}
    <p>{t('admin.keys.none')}</p>
  {/if}
  {#each keys as key (key.id)}
    <form method="post" action="?section=api&/revokeKey" class="ui-card-form">
      <Card title={key.name}>
        {#if key.revokedAt}
          <ul class="ui-badges">
            <li><Badge tone="error">{t('admin.keys.revoked')}</Badge></li>
          </ul>
        {/if}
        <div class="ui-meta-host">
          <dl class="ui-meta">
            <div>
              <dt>{t('admin.keys.role')}</dt>
              <dd>
                {key.role === 'custom'
                  ? fill(t('admin.role.customSet'), { list: key.capabilities.join(', ') })
                  : t(`admin.role.${key.role}` as UiKey)}
              </dd>
            </div>
            <div>
              <dt>{t('admin.keys.prefix')}</dt>
              <dd><code>{key.prefix}</code></dd>
            </div>
            <div>
              <dt>{t('admin.keys.created')}</dt>
              <dd>{when(key.createdAt)}</dd>
            </div>
            <div>
              <dt>{t('admin.keys.lastUsed')}</dt>
              <dd>{when(key.lastUsedAt) ?? t('admin.keys.never')}</dd>
            </div>
            {#if key.revokedAt}
              <div>
                <dt>{t('admin.keys.revoked')}</dt>
                <dd>{when(key.revokedAt)}</dd>
              </div>
            {/if}
          </dl>
        </div>
        {#if !key.revokedAt}
          <input type="hidden" name="id" value={key.id} />
          <!-- The card title shows the name; the confirmation's accessible names repeat it, so
               each row's controls stay distinct without an unbreakable name in a visible label
               (a key name has no break opportunity; WCAG 2.5.3). -->
          <Actions>
            <ConfirmAction
              label={t('admin.keys.revoke')}
              question={t('admin.keys.revokeQuestion')}
              confirm={t('admin.keys.revokeConfirm')}
              name={key.name}
            />
          </Actions>
        {/if}
      </Card>
    </form>
  {/each}
</SettingsSection>
