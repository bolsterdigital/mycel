<!-- Managed webhooks use native forms and one registry. Action buttons wrap at narrow widths;
     no credential, payload or error body is rendered after submission. -->
<script lang="ts">
  import Header from '#lib/admin/Header.svelte';
  import { ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const allowed = (capability: string) =>
    data.capabilities.includes(capability as (typeof data.capabilities)[number]) ||
    data.capabilities.includes('tenant:admin');
  const rows = (id: string) => data.intents.find((group) => group.connectionId === id)?.rows ?? [];
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const confirming = $derived(form && 'confirm' in form ? form.confirm : null);
</script>

<svelte:head><title>{t('admin.connections.title')} · {data.tenant.name}</title></svelte:head>
<Header locale={data.locale} email={data.email} />
<main class="page admin">
  <h1>{t('admin.connections.title')}</h1>
  <p><a href="/admin/{data.tenant.slug}">{t('admin.connections.back')}</a></p>
  <p>{t('admin.connections.intro')}</p>

  {#if failed}
    <div class="error-summary" role="alert">
      <h2>{t('error.summary.title')}</h2>
      <p>{t(failed.error as UiKey)}</p>
    </div>
  {/if}
  {#if done}<p class="notice" role="status">{t(done.done as UiKey)}</p>{/if}
  {#if confirming}
    <section class="notice" aria-labelledby="disconnect-title">
      <h2 id="disconnect-title">{t('admin.connections.disconnect.title')}</h2>
      <p>{t('admin.connections.disconnect.warning')}</p>
      <form method="post" action="?/disconnect" class="connection-actions">
        <input type="hidden" name="id" value={confirming.id} />
        <input type="hidden" name="version" value={confirming.version} />
        <input type="hidden" name="confirm" value="yes" />
        <button type="submit">{t('admin.connections.disconnect.confirm')}</button>
        <a class="button secondary" href="/admin/{data.tenant.slug}/connections"
          >{t('admin.connections.cancel')}</a
        >
      </form>
    </section>
  {/if}

  {#if allowed('connections:configure')}
    <section aria-labelledby="create-title">
      <h2 id="create-title">{t('admin.connections.create.title')}</h2>
      <form method="post" action="?/create" class="card fields">
        <label for="create-owner">{t('admin.connections.owner')}</label>
        <input id="create-owner" name="externalOwner" required maxlength="160" />
        <label for="create-maintainer">{t('admin.connections.maintainer')}</label>
        <input id="create-maintainer" name="maintainer" required maxlength="160" />
        <label for="create-purpose">{t('admin.connections.purpose')}</label>
        <input id="create-purpose" name="purpose" required maxlength="160" />
        <label for="create-destination">{t('admin.connections.destination')}</label>
        <input
          id="create-destination"
          name="destination"
          type="url"
          required
          placeholder="https://hooks.example.org/mycel"
        />
        <label for="create-scopes">{t('admin.connections.scopes')}</label>
        <input id="create-scopes" name="consentScopes" required placeholder="newsletter:main" />
        <p class="muted">{t('admin.connections.create.help')}</p>
        <button type="submit">{t('admin.connections.create.submit')}</button>
      </form>
    </section>
  {/if}

  <section aria-labelledby="inventory-title">
    <h2 id="inventory-title">{t('admin.connections.inventory')}</h2>
    {#if data.connections.length === 0}<p>{t('admin.connections.none')}</p>{/if}
    {#each data.connections as connection (connection.id)}
      <article class="card" aria-labelledby="connection-{connection.id}">
        <h3 id="connection-{connection.id}">{connection.purpose}</h3>
        <dl>
          <dt>{t('admin.connections.provider')}</dt>
          <dd>{connection.provider}</dd>
          <dt>{t('admin.connections.owner')}</dt>
          <dd>{connection.externalOwner}</dd>
          <dt>{t('admin.connections.maintainer')}</dt>
          <dd>{connection.maintainer}</dd>
          <dt>{t('admin.connections.destination')}</dt>
          <dd class="break">{connection.destination ?? '–'}</dd>
          <dt>{t('admin.connections.scopes')}</dt>
          <dd>{connection.consentScopes.join(', ')}</dd>
          <dt>{t('admin.connections.state')}</dt>
          <dd>{t(`admin.connections.state.${connection.state}` as UiKey)}</dd>
          <dt>{t('admin.connections.credential')}</dt>
          <dd>{t(`admin.connections.credential.${connection.credentialStatus}` as UiKey)}</dd>
        </dl>
        {#if connection.provider === 'webhook' && connection.state !== 'disconnected'}
          {#if allowed('connections:configure')}
            <form method="post" action="?/update" class="fields">
              <input type="hidden" name="id" value={connection.id} />
              <input type="hidden" name="version" value={connection.version} />
              <label for="owner-{connection.id}">{t('admin.connections.owner')}</label>
              <input
                id="owner-{connection.id}"
                name="externalOwner"
                value={connection.externalOwner}
                required
                maxlength="160"
              />
              <label for="maintainer-{connection.id}">{t('admin.connections.maintainer')}</label>
              <input
                id="maintainer-{connection.id}"
                name="maintainer"
                value={connection.maintainer}
                required
                maxlength="160"
              />
              <label for="purpose-{connection.id}">{t('admin.connections.purpose')}</label>
              <input
                id="purpose-{connection.id}"
                name="purpose"
                value={connection.purpose}
                required
                maxlength="160"
              />
              <label for="destination-{connection.id}">{t('admin.connections.destination')}</label>
              <input
                id="destination-{connection.id}"
                name="destination"
                type="url"
                value={connection.destination ?? ''}
                required
              />
              <label for="scopes-{connection.id}">{t('admin.connections.scopes')}</label>
              <input
                id="scopes-{connection.id}"
                name="consentScopes"
                value={connection.consentScopes.join(', ')}
                required
              />
              <button type="submit">{t('admin.connections.save')}</button>
            </form>
          {/if}
          {#if allowed('connections:credentials')}
            <form method="post" action="?/credential" class="fields">
              <input type="hidden" name="id" value={connection.id} />
              <input type="hidden" name="version" value={connection.version} />
              <label for="secret-{connection.id}">{t('admin.connections.secret')}</label>
              <input
                id="secret-{connection.id}"
                name="secret"
                type="password"
                autocomplete="new-password"
                required
              />
              <button type="submit">{t('admin.connections.credential.replace')}</button>
            </form>
          {/if}
          {#if allowed('connections:configure')}
            <div class="connection-actions">
              {#if connection.state === 'active'}
                <form method="post" action="?/pause">
                  <input type="hidden" name="id" value={connection.id} /><input
                    type="hidden"
                    name="version"
                    value={connection.version}
                  /><button type="submit">{t('admin.connections.pause')}</button>
                </form>
                <form method="post" action="?/test">
                  <input type="hidden" name="id" value={connection.id} /><button type="submit"
                    >{t('admin.connections.test')}</button
                  >
                </form>
              {:else}
                <form method="post" action="?/resume">
                  <input type="hidden" name="id" value={connection.id} /><input
                    type="hidden"
                    name="version"
                    value={connection.version}
                  /><button type="submit">{t('admin.connections.resume')}</button>
                </form>
              {/if}
              <form method="post" action="?/disconnect">
                <input type="hidden" name="id" value={connection.id} /><input
                  type="hidden"
                  name="version"
                  value={connection.version}
                /><button type="submit" class="secondary"
                  >{t('admin.connections.disconnect')}</button
                >
              </form>
            </div>
          {/if}
        {/if}
        <h4>{t('admin.connections.health')}</h4>
        {#if rows(connection.id).length === 0}<p>{t('admin.connections.noIntents')}</p>{/if}
        {#each rows(connection.id) as intent (intent.id)}
          <div class="intent">
            <p>
              <code>{intent.id}</code> · {t(`admin.connections.delivery.${intent.state}` as UiKey)} ·
              {intent.externalCopyAction === null
                ? t('admin.connections.synthetic')
                : t(`admin.connections.copy.${intent.externalCopyAction}` as UiKey)} · {intent.failure ??
                ''}
            </p>
            {#if allowed('connections:replay') && (intent.state === 'pending' || intent.state === 'unknown')}
              <form method="post" action="?/replay">
                <input type="hidden" name="id" value={intent.id} /><button type="submit"
                  >{t('admin.connections.replay')}</button
                >
              </form>
            {/if}
          </div>
        {/each}
      </article>
    {/each}
  </section>
  <p>{t('admin.connections.unknown.help')}</p>
</main>

<style>
  .fields {
    display: grid;
    gap: 0.5rem;
    max-inline-size: 40rem;
    margin-block: 1rem;
  }
  .fields input {
    max-inline-size: 40ch;
    width: 100%;
  }
  .fields button {
    justify-self: start;
  }
  .connection-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block: 1rem;
  }
  .connection-actions > * {
    max-inline-size: 100%;
  }
  button,
  .button {
    min-block-size: 44px;
    min-inline-size: 44px;
    white-space: normal;
    overflow-wrap: normal;
  }
  .break {
    overflow-wrap: anywhere;
  }
  .intent {
    border-block-start: 1px solid currentColor;
    padding-block: 0.5rem;
  }
  .intent code {
    overflow-wrap: anywhere;
  }
</style>
