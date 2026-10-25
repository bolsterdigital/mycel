<!-- The tenant's admin page: members and API keys (TODO #7), the site's hostnames (TODO #14) and
     its usage against the limits (TODO #16), with a link to the media library (TODO #10b);
     its pages and articles have their own pages since TODO #11. Every action is a native form post. Action groups wrap whole
     buttons onto a new line when they do not fit, and a long label wraps inside its own button
     at word boundaries (skill ui-action-layout); the e2e specs check 320 CSS px and 200% text. -->
<script lang="ts">
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
  const verify = $derived(form && 'verify' in form ? form.verify : null);
  const number = $derived(new Intl.NumberFormat(data.locale));
  const of = (used: number | string, max: number | string) =>
    fill(t('admin.usage.of'), {
      used: typeof used === 'number' ? number.format(used) : used,
      max: typeof max === 'number' ? number.format(max) : max,
    });
  const bytes = (n: number) =>
    new Intl.NumberFormat(data.locale, {
      style: 'unit',
      unit: n >= 1024 ** 3 ? 'gigabyte' : 'megabyte',
      maximumFractionDigits: 1,
    }).format(n / (n >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2));
  const vars = (f: Record<string, unknown>) => ({
    email: typeof f.email === 'string' ? f.email : '',
    hostname: typeof f.hostname === 'string' ? f.hostname : '',
  });
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

<main class="page admin">
  <h1>{data.tenant.name}</h1>

  {#if failed}
    <div class="error-summary" role="alert">
      <h2>{t('error.summary.title')}</h2>
      <p>
        {'what' in failed && failed.what
          ? fill(t(failed.error as UiKey), { what: t(failed.what as UiKey) })
          : t(failed.error as UiKey)}
      </p>
    </div>
  {/if}
  {#if done}
    <div class="notice" role="status">
      <p>{fill(t(done.done as UiKey), vars(done))}</p>
      {#if 'revokedKeys' in done && Number(done.revokedKeys) > 0}
        <p>{fill(t('admin.done.revokedKeys'), { n: Number(done.revokedKeys) })}</p>
      {/if}
    </div>
  {/if}
  {#if verify && !verify.checked}
    <div class="notice" role="status">
      <p>{fill(t('admin.domains.done.unavailable'), { hostname: verify.hostname })}</p>
    </div>
  {:else if verify}
    <div class="notice" role="status">
      <p>
        {fill(
          t(verify.verified ? 'admin.domains.done.verified' : 'admin.domains.done.notVerified'),
          {
            hostname: verify.hostname,
          }
        )}
      </p>
      {#if !verify.verified}
        <p>
          {verify.found.txt.length
            ? fill(t('admin.domains.found.txt'), { values: verify.found.txt.join(', ') })
            : fill(t('admin.domains.found.noTxt'), { name: `_mycel-verify.${verify.hostname}` })}
        </p>
      {/if}
      <p>
        {verify.pointsToPlatform
          ? t('admin.domains.found.cnameOk')
          : verify.found.cname
            ? fill(t('admin.domains.found.cname'), { target: verify.found.cname })
            : t('admin.domains.found.noCname')}
      </p>
    </div>
  {/if}
  {#if token}
    <section class="notice token" aria-labelledby="token-title">
      <h2 id="token-title">{t('admin.keys.token.title')}: {token.keyName}</h2>
      <p>{t('admin.keys.token.body')}</p>
      <p><code class="token-value">{token.token}</code></p>
    </section>
  {/if}

  {#if data.usage.status === 'suspended'}
    <div class="notice" role="status">
      <p>{t('admin.suspended')}</p>
      {#if data.capabilities.includes('tenant:admin')}
        <p><a href="/admin/{data.tenant.slug}/export">{t('admin.suspended.export')}</a></p>
      {/if}
    </div>
  {/if}

  <section aria-labelledby="usage">
    <h2 id="usage">{t('admin.usage.title')}</h2>
    <dl>
      <dt>{t('admin.usage.supporters')}</dt>
      <dd>{of(data.usage.supporters.used, data.usage.supporters.max)}</dd>
      <dt>{t('admin.usage.mail')}</dt>
      <dd>{of(data.usage.mail.usedThisMonth, data.usage.mail.max)}</dd>
      <dt>{t('admin.usage.storage')}</dt>
      <dd>{of(bytes(data.usage.storage.usedBytes), bytes(data.usage.storage.maxBytes))}</dd>
      <dt>{t('admin.usage.operators')}</dt>
      <dd>{of(data.usage.operators.used, data.usage.operators.max)}</dd>
      <dt>{t('admin.usage.customDomains')}</dt>
      <dd>{of(data.usage.customDomains.used, data.usage.customDomains.max)}</dd>
    </dl>
  </section>

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

  <section aria-labelledby="domains">
    <h2 id="domains">{t('admin.domains.title')}</h2>
    <p>{t('admin.domains.intro')}</p>
    {#each data.hostnames as h (h.hostname)}
      <form
        method="post"
        action={h.kind === 'custom' ? '?/verifyHostname' : '?/setPrimaryHostname'}
        class="card"
      >
        <h3>
          {h.display}{#if h.display !== h.hostname}
            <span class="muted">({h.hostname})</span>{/if}
        </h3>
        <ul class="tags">
          <li>
            {t(h.kind === 'platform' ? 'admin.domains.kind.platform' : 'admin.domains.kind.custom')}
          </li>
          {#if h.primary}<li>{t('admin.domains.primary')}</li>{/if}
          <li>{t(h.verifiedAt ? 'admin.domains.verified' : 'admin.domains.unverified')}</li>
        </ul>
        {#if h.kind === 'custom'}
          <p class="muted">
            {h.lastCheckedAt === null
              ? t('admin.domains.checks.none')
              : fill(
                  t(
                    h.checkFailures > 0 ? 'admin.domains.checks.failing' : 'admin.domains.checks.ok'
                  ),
                  { when: when(h.lastCheckedAt) ?? '', n: h.checkFailures }
                )}
          </p>
        {/if}
        {#if h.dns}
          <h4>{t('admin.domains.dns.title')}</h4>
          <dl>
            <dt>{t('admin.domains.dns.txt')}: {t('admin.domains.dns.name')}</dt>
            <dd><code>{h.dns.txt.name}</code></dd>
            <dt>{t('admin.domains.dns.txt')}: {t('admin.domains.dns.value')}</dt>
            <dd><code class="dns-value">{h.dns.txt.value}</code></dd>
            <dt>{t('admin.domains.dns.cname')}: {t('admin.domains.dns.name')}</dt>
            <dd><code>{h.dns.cname.name}</code></dd>
            <dt>{t('admin.domains.dns.cname')}: {t('admin.domains.dns.target')}</dt>
            <dd><code>{h.dns.cname.target}</code></dd>
          </dl>
          <p class="muted">{t('admin.domains.dns.apex')}</p>
        {/if}
        <input type="hidden" name="hostname" value={h.hostname} />
        {#if h.kind === 'custom' || !h.primary}
          <div class="actions">
            {#if h.kind === 'custom'}
              <button type="submit" formaction="?/verifyHostname">{t('admin.domains.check')}</button
              >
            {/if}
            {#if h.verifiedAt && !h.primary}
              <button type="submit" formaction="?/setPrimaryHostname" class="secondary">
                {t('admin.domains.makePrimary')}
              </button>
            {/if}
            {#if h.kind === 'custom' && !h.primary}
              <button type="submit" formaction="?/removeHostname" class="secondary">
                {t('admin.domains.remove')}
              </button>
            {/if}
          </div>
        {/if}
      </form>
    {/each}

    <form method="post" action="?/addHostname" class="card">
      <h3>{t('admin.domains.add.title')}</h3>
      <div class="field">
        <label for="add-hostname">{t('admin.domains.add.hostname')}</label>
        <input
          id="add-hostname"
          name="hostname"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          required
          maxlength="300"
          value={failed?.action === 'addHostname' ? (failed.hostname ?? '') : ''}
        />
      </div>
      <p class="muted">{t('admin.domains.add.hint')}</p>
      <div class="actions">
        <button type="submit">{t('admin.domains.add.submit')}</button>
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
