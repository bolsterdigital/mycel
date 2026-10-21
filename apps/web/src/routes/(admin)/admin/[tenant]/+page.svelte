<!-- The tenant's admin page for TODO #7: members and API keys, nothing else (TODO #11 builds the
     real admin). Every action is a native form post. Action groups wrap whole buttons onto a new
     line when they do not fit, and a long label wraps inside its own button at word boundaries
     (skill ui-action-layout); the e2e spec checks 320 CSS px and 200% text. -->
<script lang="ts">
  import Header from '#lib/admin/Header.svelte';
  import { fill, ui, type UiKey } from '../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));

  /** Lets a long capability break after its colon instead of overflowing a narrow screen. */
  const parts = (capability: string) => capability.split(':');
  const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : null);
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const token = $derived(form && 'token' in form ? form : null);
</script>

<svelte:head>
  <title>{failed ? `${t('error.prefix')} ` : ''}{data.tenant.name} · {t('admin.title')}</title>
</svelte:head>

{#snippet capability(name: string)}{parts(name)[0]}:<wbr />{parts(name)[1]}{/snippet}

{#snippet checkboxes(id: string, options: readonly string[], checked: readonly string[])}
  <ul class="capabilities">
    {#each options as option (option)}
      <li>
        <input
          type="checkbox"
          id="{id}-{option}"
          name="capabilities"
          value={option}
          checked={checked.includes(option)}
        />
        <label for="{id}-{option}">{@render capability(option)}</label>
      </li>
    {/each}
  </ul>
{/snippet}

<Header locale={data.locale} email={data.email} />
<main class="page admin">
  <h1>{data.tenant.name}</h1>
  <p><a href="/admin">{t('admin.back')}</a></p>

  {#if failed}
    <div class="error-summary" role="alert">
      <h2>{t('error.summary.title')}</h2>
      <p>{t(failed.error as UiKey)}</p>
    </div>
  {/if}
  {#if done}
    <div class="notice" role="status">
      <p>{fill(t(done.done as UiKey), { email: 'email' in done ? String(done.email) : '' })}</p>
      {#if 'revokedKeys' in done && Number(done.revokedKeys) > 0}
        <p>{fill(t('admin.done.revokedKeys'), { n: Number(done.revokedKeys) })}</p>
      {/if}
    </div>
  {/if}
  {#if token}
    <section class="notice token" aria-labelledby="token-title">
      <h2 id="token-title">{t('admin.keys.token.title')}: {token.keyName}</h2>
      <p>{t('admin.keys.token.body')}</p>
      <p><code class="token-value">{token.token}</code></p>
    </section>
  {/if}

  <section aria-labelledby="mine">
    <h2 id="mine">{t('admin.yourCapabilities')}</h2>
    <ul class="tags">
      {#each data.capabilities as c (c)}<li>{@render capability(c)}</li>{/each}
    </ul>
  </section>

  <section aria-labelledby="members">
    <h2 id="members">{t('admin.members.title')}</h2>
    <p>{t('admin.members.note')}</p>
    {#each data.members as member (member.operatorId)}
      <form method="post" action="?/update" class="card">
        <h3>
          {member.email}{#if member.name}
            ({member.name}){/if}
        </h3>
        {#if member.pending}<p class="muted">{t('admin.members.pending')}</p>{/if}
        <input type="hidden" name="operatorId" value={member.operatorId} />
        <fieldset>
          <legend>{fill(t('admin.members.capabilities'), { email: member.email })}</legend>
          {@render checkboxes(`m-${member.operatorId}`, data.allCapabilities, member.capabilities)}
        </fieldset>
        <div class="actions">
          <button type="submit">{t('admin.members.save')}</button>
          <button type="submit" formaction="?/remove" class="secondary">
            {t('admin.members.remove')}
          </button>
        </div>
      </form>
    {/each}

    <form method="post" action="?/invite" class="card">
      <h3>{t('admin.invite.title')}</h3>
      <div class="field">
        <label for="invite-email">{t('admin.invite.email')}</label>
        <input
          id="invite-email"
          name="email"
          type="email"
          autocomplete="off"
          required
          value={failed?.action === 'invite' ? (failed.email ?? '') : ''}
        />
      </div>
      <fieldset>
        <legend>{t('admin.invite.capabilities')}</legend>
        {@render checkboxes('invite', data.allCapabilities, [])}
      </fieldset>
      <p class="muted">{fill(t('admin.invite.hint'), { url: data.loginUrl })}</p>
      <div class="actions">
        <button type="submit">{t('admin.invite.submit')}</button>
      </div>
    </form>
  </section>

  <section aria-labelledby="keys">
    <h2 id="keys">{t('admin.keys.title')}</h2>
    {#if data.keys.length === 0}
      <p>{t('admin.keys.none')}</p>
    {/if}
    {#each data.keys as key (key.id)}
      <form method="post" action="?/revokeKey" class="card">
        <h3>{key.name}</h3>
        <dl>
          <dt>{t('admin.keys.prefix')}</dt>
          <dd><code>{key.prefix}</code></dd>
          <dt>{t('admin.keys.capabilities')}</dt>
          <dd>
            <ul class="tags">
              {#each key.capabilities as c (c)}<li>{@render capability(c)}</li>{/each}
            </ul>
          </dd>
          <dt>{t('admin.keys.created')}</dt>
          <dd>{when(key.createdAt)}</dd>
          <dt>{t('admin.keys.lastUsed')}</dt>
          <dd>{when(key.lastUsedAt) ?? t('admin.keys.never')}</dd>
          {#if key.revokedAt}
            <dt>{t('admin.keys.revoked')}</dt>
            <dd>{when(key.revokedAt)}</dd>
          {/if}
        </dl>
        {#if !key.revokedAt}
          <input type="hidden" name="id" value={key.id} />
          <div class="actions">
            <button type="submit" class="secondary">
              {fill(t('admin.keys.revoke'), { name: key.name })}
            </button>
          </div>
        {/if}
      </form>
    {/each}

    <form method="post" action="?/createKey" class="card">
      <h3>{t('admin.keys.create.title')}</h3>
      <div class="field">
        <label for="key-name">{t('admin.keys.create.name')}</label>
        <input id="key-name" name="name" type="text" required maxlength="100" />
      </div>
      <fieldset>
        <legend>{t('admin.keys.create.capabilities')}</legend>
        {@render checkboxes('key', data.keyCapabilities, [])}
      </fieldset>
      <p class="muted">{t('admin.keys.create.hint')}</p>
      <div class="actions">
        <button type="submit">{t('admin.keys.create.submit')}</button>
      </div>
    </form>
  </section>
</main>
