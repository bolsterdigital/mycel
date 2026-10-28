<!-- Managed webhooks (#40) on the shared admin components (brief #56): one card per connection
     with its facts as a MetaList, the details form folded away (it rarely changes, skill
     cms-inrichting), the signing secret, one action group and the latest delivery attempts.
     Every action is a native form post; no credential, payload or error body is rendered after
     submission. Action groups wrap whole buttons; e2e/connections.spec.ts checks 320 CSS px and
     200% text. -->
<script lang="ts">
  import {
    Actions,
    Button,
    Card,
    Field,
    Fieldset,
    MetaList,
    Notice,
    PageHeader,
  } from '#lib/admin/ui/index.js';
  import { ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const allowed = (capability: string) =>
    data.capabilities.includes(capability as (typeof data.capabilities)[number]) ||
    data.capabilities.includes('tenant:admin');
  const rows = (id: string) => data.intents.find((group) => group.connectionId === id)?.rows ?? [];
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const confirming = $derived(form && 'confirm' in form ? form.confirm : null);
  type Connection = (typeof data.connections)[number];
  const facts = (c: Connection) => [
    { term: t('admin.connections.provider'), value: c.provider },
    { term: t('admin.connections.owner'), value: c.externalOwner },
    { term: t('admin.connections.maintainer'), value: c.maintainer },
    { term: t('admin.connections.destination'), value: c.destination ?? '–' },
    { term: t('admin.connections.scopes'), value: c.consentScopes.join(', ') },
    { term: t('admin.connections.state'), value: t(`admin.connections.state.${c.state}` as UiKey) },
    {
      term: t('admin.connections.credential'),
      value: t(`admin.connections.credential.${c.credentialStatus}` as UiKey),
    },
  ];
</script>

{#snippet details(prefix: string, c: Connection | null)}
  <Field
    id="{prefix}-owner"
    name="externalOwner"
    label={t('admin.connections.owner')}
    locale={data.locale}
    required
    maxlength={160}
    value={c?.externalOwner ?? ''}
  />
  <Field
    id="{prefix}-maintainer"
    name="maintainer"
    label={t('admin.connections.maintainer')}
    locale={data.locale}
    required
    maxlength={160}
    value={c?.maintainer ?? ''}
  />
  <Field
    id="{prefix}-purpose"
    name="purpose"
    label={t('admin.connections.purpose')}
    locale={data.locale}
    required
    maxlength={160}
    value={c?.purpose ?? ''}
  />
  <Field
    id="{prefix}-destination"
    name="destination"
    type="url"
    label={t('admin.connections.destination')}
    locale={data.locale}
    required
    placeholder={c ? undefined : 'https://hooks.example.org/mycel'}
    value={c?.destination ?? ''}
  />
  <Field
    id="{prefix}-scopes"
    name="consentScopes"
    label={t('admin.connections.scopes')}
    locale={data.locale}
    required
    placeholder={c ? undefined : 'newsletter:main'}
    value={c?.consentScopes.join(', ') ?? ''}
  />
{/snippet}

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.connections.title')} · {data.tenant
      .name}</title
  >
</svelte:head>

<main class="page admin">
  <PageHeader
    title={t('admin.connections.title')}
    locale={data.locale}
    breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.connections.title') }]}
    description={t('admin.connections.intro')}
  />

  {#if failed}
    <Notice tone="error" title={t('error.summary.title')}><p>{t(failed.error as UiKey)}</p></Notice>
  {/if}
  {#if done}
    <Notice tone="success"><p>{t(done.done as UiKey)}</p></Notice>
  {/if}
  {#if confirming}
    <Notice tone="warning">
      <form method="post" action="?/disconnect" aria-labelledby="disconnect-title">
        <h2 id="disconnect-title">{t('admin.connections.disconnect.title')}</h2>
        <p>{t('admin.connections.disconnect.warning')}</p>
        <input type="hidden" name="id" value={confirming.id} />
        <input type="hidden" name="version" value={confirming.version} />
        <input type="hidden" name="confirm" value="yes" />
        <Actions>
          <Button variant="danger">{t('admin.connections.disconnect.confirm')}</Button>
          <Button variant="secondary" href="{base}/connections"
            >{t('admin.connections.cancel')}</Button
          >
        </Actions>
      </form>
    </Notice>
  {/if}

  {#if allowed('connections:configure')}
    <section aria-labelledby="create-title">
      <h2 id="create-title">{t('admin.connections.create.title')}</h2>
      <form method="post" action="?/create" class="ui-fields">
        {@render details('create', null)}
        <p class="ui-hint">{t('admin.connections.create.help')}</p>
        <Actions><Button>{t('admin.connections.create.submit')}</Button></Actions>
      </form>
    </section>
  {/if}

  <section aria-labelledby="inventory-title">
    <h2 id="inventory-title">{t('admin.connections.inventory')}</h2>
    {#if data.connections.length === 0}<p>{t('admin.connections.none')}</p>{/if}
    {#each data.connections as connection (connection.id)}
      {@const live = connection.provider === 'webhook' && connection.state !== 'disconnected'}
      <Card title={connection.purpose}>
        <MetaList items={facts(connection)} />
        {#if live && allowed('connections:configure')}
          <form method="post" action="?/update" class="ui-fields">
            <input type="hidden" name="id" value={connection.id} />
            <input type="hidden" name="version" value={connection.version} />
            <Fieldset legend={t('admin.connections.edit')} collapsed>
              {@render details(connection.id, connection)}
              <Actions><Button>{t('admin.connections.save')}</Button></Actions>
            </Fieldset>
          </form>
        {/if}
        {#if live && allowed('connections:credentials')}
          <form method="post" action="?/credential" class="ui-fields">
            <input type="hidden" name="id" value={connection.id} />
            <input type="hidden" name="version" value={connection.version} />
            <Field
              id="secret-{connection.id}"
              name="secret"
              type="password"
              autocomplete="new-password"
              label={t('admin.connections.secret')}
              locale={data.locale}
              required
            />
            <Actions>
              <Button variant="secondary">{t('admin.connections.credential.replace')}</Button>
            </Actions>
          </form>
        {/if}
        {#if live && allowed('connections:configure')}
          <form method="post">
            <input type="hidden" name="id" value={connection.id} />
            <input type="hidden" name="version" value={connection.version} />
            <Actions>
              {#if connection.state === 'active'}
                <Button variant="secondary" formaction="?/pause"
                  >{t('admin.connections.pause')}</Button
                >
                <Button variant="secondary" formaction="?/test"
                  >{t('admin.connections.test')}</Button
                >
              {:else}
                <Button formaction="?/resume">{t('admin.connections.resume')}</Button>
              {/if}
              <Button variant="danger" formaction="?/disconnect"
                >{t('admin.connections.disconnect')}</Button
              >
            </Actions>
          </form>
        {/if}
        <h4>{t('admin.connections.health')}</h4>
        {#if rows(connection.id).length === 0}
          <p>{t('admin.connections.noIntents')}</p>
        {:else}
          <ul class="intents">
            {#each rows(connection.id) as intent (intent.id)}
              <li class="intent">
                <p>
                  <code>{intent.id}</code> · {t(
                    `admin.connections.delivery.${intent.state}` as UiKey
                  )} ·
                  {intent.externalCopyAction === null
                    ? t('admin.connections.synthetic')
                    : t(
                        `admin.connections.copy.${intent.externalCopyAction}` as UiKey
                      )}{intent.failure ? ` · ${intent.failure}` : ''}
                </p>
                {#if intent.operatorAction === 'resolve'}
                  <p class="ui-hint">{t('admin.connections.unknown.help')}</p>
                {/if}
                {#if allowed('connections:replay') && intent.operatorAction}
                  <form method="post" action="?/{intent.operatorAction}">
                    <input type="hidden" name="id" value={intent.id} />
                    <Actions>
                      <Button variant="secondary"
                        >{t(`admin.connections.${intent.operatorAction}` as UiKey)}</Button
                      >
                    </Actions>
                  </form>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </Card>
    {/each}
  </section>
</main>

<style>
  /* The attempts are a plain list of rows under the card's facts; an id never widens the card. */
  .intents {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .intent {
    border-block-start: var(--border-width) solid var(--color-border);
    padding-block: var(--space-1);
  }
  .intent code {
    overflow-wrap: anywhere;
  }
</style>
