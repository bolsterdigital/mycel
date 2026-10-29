<!-- The tenant's admin page: members and API keys (TODO #7), the site's hostnames (TODO #14) and
     its usage against the limits (TODO #16); pages, articles and media have their own screens.
     Every action is a native form post. Action groups wrap whole buttons onto a new line when
     they do not fit, and a long label wraps inside its own button at word boundaries (skill
     ui-action-layout); the e2e specs check 320 CSS px and 200% text.
     The whole page is on the shared basis (brief #56 § C3, dev PR B): page header, notices, usage
     as a definition list, capabilities as badges, and every member, domain and key a form around
     a card with its checkboxes as `Choices` and its buttons as one `Actions` group. The form wraps
     the card, not the other way round, so a card's buttons share one form via `formaction`. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Card,
    Choices,
    Field,
    MetaList,
    Notice,
    PageHeader,
  } from '#lib/admin/ui/index.js';
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
  const options = (list: readonly string[]) => list.map((c) => ({ value: c, label: c }));
  const vars = (f: Record<string, unknown>) => ({
    email: typeof f.email === 'string' ? f.email : '',
    hostname: typeof f.hostname === 'string' ? f.hostname : '',
  });
</script>

<svelte:head>
  <title>{failed ? `${t('error.prefix')} ` : ''}{data.tenant.name} · {t('admin.title')}</title>
</svelte:head>

{#snippet capability(name: string)}{parts(name)[0]}:<wbr />{parts(name)[1]}{/snippet}
{#snippet choice(option: { value: string })}{@render capability(option.value)}{/snippet}

<main class="page admin">
  <PageHeader title={data.tenant.name} locale={data.locale} />

  {#if failed}
    <Notice tone="error" title={t('error.summary.title')}>
      <p>
        {'what' in failed && failed.what
          ? fill(t(failed.error as UiKey), { what: t(failed.what as UiKey) })
          : t(failed.error as UiKey)}
      </p>
    </Notice>
  {/if}
  {#if done}
    <Notice tone="success">
      <p>{fill(t(done.done as UiKey), vars(done))}</p>
      {#if 'revokedKeys' in done && Number(done.revokedKeys) > 0}
        <p>{fill(t('admin.done.revokedKeys'), { n: Number(done.revokedKeys) })}</p>
      {/if}
    </Notice>
  {/if}
  {#if verify && !verify.checked}
    <Notice tone="warning">
      <p>{fill(t('admin.domains.done.unavailable'), { hostname: verify.hostname })}</p>
    </Notice>
  {:else if verify}
    <Notice tone={verify.verified ? 'success' : 'warning'}>
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
    </Notice>
  {/if}
  {#if token}
    <Notice tone="success" title="{t('admin.keys.token.title')}: {token.keyName}">
      <p>{t('admin.keys.token.body')}</p>
      <p><code class="token-value">{token.token}</code></p>
    </Notice>
  {/if}

  {#if data.usage.status === 'suspended'}
    <Notice tone="warning">
      <p>{t('admin.suspended')}</p>
      {#if data.capabilities.includes('tenant:admin')}
        <p><a href="/admin/{data.tenant.slug}/export">{t('admin.suspended.export')}</a></p>
      {/if}
    </Notice>
  {/if}

  <section aria-labelledby="usage">
    <h2 id="usage">{t('admin.usage.title')}</h2>
    <MetaList
      items={[
        {
          term: t('admin.usage.supporters'),
          value: of(data.usage.supporters.used, data.usage.supporters.max),
        },
        {
          term: t('admin.usage.mail'),
          value: of(data.usage.mail.usedThisMonth, data.usage.mail.max),
        },
        {
          term: t('admin.usage.storage'),
          value: of(bytes(data.usage.storage.usedBytes), bytes(data.usage.storage.maxBytes)),
        },
        {
          term: t('admin.usage.operators'),
          value: of(data.usage.operators.used, data.usage.operators.max),
        },
        {
          term: t('admin.usage.customDomains'),
          value: of(data.usage.customDomains.used, data.usage.customDomains.max),
        },
      ]}
    />
  </section>

  <section aria-labelledby="mine">
    <h2 id="mine">{t('admin.yourCapabilities')}</h2>
    <ul class="ui-badges">
      {#each data.capabilities as c (c)}<li><Badge>{@render capability(c)}</Badge></li>{/each}
    </ul>
  </section>

  <section aria-labelledby="members">
    <h2 id="members">{t('admin.members.title')}</h2>
    <p>{t('admin.members.note')}</p>
    {#each data.members as member (member.operatorId)}
      <form method="post" action="?/update" class="ui-card-form">
        <Card title={member.name ? `${member.email} (${member.name})` : member.email}>
          {#if member.pending}
            <ul class="ui-badges">
              <li><Badge tone="warning">{t('admin.members.pending')}</Badge></li>
            </ul>
          {/if}
          <input type="hidden" name="operatorId" value={member.operatorId} />
          <Choices
            id="m-{member.operatorId}"
            name="capabilities"
            type="checkbox"
            legend={fill(t('admin.members.capabilities'), { email: member.email })}
            locale={data.locale}
            options={options(data.allCapabilities)}
            selected={member.capabilities}
            optionLabel={choice}
          />
          <Actions>
            <Button>{t('admin.members.save')}</Button>
            <Button variant="secondary" formaction="?/remove">{t('admin.members.remove')}</Button>
          </Actions>
        </Card>
      </form>
    {/each}

    <form method="post" action="?/invite" class="ui-card-form">
      <Card title={t('admin.invite.title')}>
        <Field
          id="invite-email"
          name="email"
          type="email"
          autocomplete="off"
          required
          label={t('admin.invite.email')}
          locale={data.locale}
          value={failed?.action === 'invite' ? (failed.email ?? '') : ''}
        />
        <Choices
          id="invite"
          name="capabilities"
          type="checkbox"
          legend={t('admin.invite.capabilities')}
          locale={data.locale}
          options={options(data.allCapabilities)}
          optionLabel={choice}
        />
        <p class="ui-hint">{fill(t('admin.invite.hint'), { url: data.loginUrl })}</p>
        <Actions>
          <Button>{t('admin.invite.submit')}</Button>
        </Actions>
      </Card>
    </form>
  </section>

  <section aria-labelledby="domains">
    <h2 id="domains">{t('admin.domains.title')}</h2>
    <p>{t('admin.domains.intro')}</p>
    {#each data.hostnames as h (h.hostname)}
      <form
        method="post"
        action={h.kind === 'custom' ? '?/verifyHostname' : '?/setPrimaryHostname'}
        class="ui-card-form"
      >
        <Card title={h.display !== h.hostname ? `${h.display} (${h.hostname})` : h.display}>
          <ul class="ui-badges">
            <li>
              <Badge
                >{t(
                  h.kind === 'platform'
                    ? 'admin.domains.kind.platform'
                    : 'admin.domains.kind.custom'
                )}</Badge
              >
            </li>
            {#if h.primary}<li><Badge tone="info">{t('admin.domains.primary')}</Badge></li>{/if}
            <li>
              <Badge tone={h.verifiedAt ? 'success' : 'warning'}
                >{t(h.verifiedAt ? 'admin.domains.verified' : 'admin.domains.unverified')}</Badge
              >
            </li>
          </ul>
          {#if h.kind === 'custom'}
            <p class="ui-hint">
              {h.lastCheckedAt === null
                ? t('admin.domains.checks.none')
                : fill(
                    t(
                      h.checkFailures > 0
                        ? 'admin.domains.checks.failing'
                        : 'admin.domains.checks.ok'
                    ),
                    { when: when(h.lastCheckedAt) ?? '', n: h.checkFailures }
                  )}
            </p>
          {/if}
          {#if h.dns}
            <h4>{t('admin.domains.dns.title')}</h4>
            <div class="ui-meta-host">
              <dl class="ui-meta">
                <div>
                  <dt>{t('admin.domains.dns.txt')}: {t('admin.domains.dns.name')}</dt>
                  <dd><code>{h.dns.txt.name}</code></dd>
                </div>
                <div>
                  <dt>{t('admin.domains.dns.txt')}: {t('admin.domains.dns.value')}</dt>
                  <dd><code class="dns-value">{h.dns.txt.value}</code></dd>
                </div>
                <div>
                  <dt>{t('admin.domains.dns.cname')}: {t('admin.domains.dns.name')}</dt>
                  <dd><code>{h.dns.cname.name}</code></dd>
                </div>
                <div>
                  <dt>{t('admin.domains.dns.cname')}: {t('admin.domains.dns.target')}</dt>
                  <dd><code>{h.dns.cname.target}</code></dd>
                </div>
              </dl>
            </div>
            <p class="ui-hint">{t('admin.domains.dns.apex')}</p>
          {/if}
          <input type="hidden" name="hostname" value={h.hostname} />
          {#if h.kind === 'custom' || !h.primary}
            <Actions>
              {#if h.kind === 'custom'}
                <Button formaction="?/verifyHostname">{t('admin.domains.check')}</Button>
              {/if}
              {#if h.verifiedAt && !h.primary}
                <Button variant="secondary" formaction="?/setPrimaryHostname"
                  >{t('admin.domains.makePrimary')}</Button
                >
              {/if}
              {#if h.kind === 'custom' && !h.primary}
                <Button variant="secondary" formaction="?/removeHostname"
                  >{t('admin.domains.remove')}</Button
                >
              {/if}
            </Actions>
          {/if}
        </Card>
      </form>
    {/each}

    <form method="post" action="?/addHostname" class="ui-card-form">
      <Card title={t('admin.domains.add.title')}>
        <Field
          id="add-hostname"
          name="hostname"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          required
          maxlength={300}
          label={t('admin.domains.add.hostname')}
          hint={t('admin.domains.add.hint')}
          locale={data.locale}
          value={failed?.action === 'addHostname' ? (failed.hostname ?? '') : ''}
        />
        <Actions>
          <Button>{t('admin.domains.add.submit')}</Button>
        </Actions>
      </Card>
    </form>
  </section>

  <section aria-labelledby="keys">
    <h2 id="keys">{t('admin.keys.title')}</h2>
    {#if data.keys.length === 0}
      <p>{t('admin.keys.none')}</p>
    {/if}
    {#each data.keys as key (key.id)}
      <form method="post" action="?/revokeKey" class="ui-card-form">
        <Card title={key.name}>
          <div class="ui-meta-host">
            <dl class="ui-meta">
              <div>
                <dt>{t('admin.keys.prefix')}</dt>
                <dd><code>{key.prefix}</code></dd>
              </div>
              <div>
                <dt>{t('admin.keys.capabilities')}</dt>
                <dd>
                  <ul class="ui-badges">
                    {#each key.capabilities as c (c)}<li>
                        <Badge>{@render capability(c)}</Badge>
                      </li>{/each}
                  </ul>
                </dd>
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
            <Actions>
              <!-- A key name is an identifier without break opportunities: in the visible label it
                   overflowed the button at 320 CSS px and 200% text, and a button keeps its words
                   whole (TODO #63). The card title shows the name; the accessible name starts with
                   the visible label and adds the name, so each button stays distinct (WCAG 2.5.3). -->
              <Button
                variant="secondary"
                aria-label={fill(t('admin.keys.revokeName'), { name: key.name })}
                >{t('admin.keys.revoke')}</Button
              >
            </Actions>
          {/if}
        </Card>
      </form>
    {/each}

    <form method="post" action="?/createKey" class="ui-card-form">
      <Card title={t('admin.keys.create.title')}>
        <Field
          id="key-name"
          name="name"
          type="text"
          required
          maxlength={100}
          label={t('admin.keys.create.name')}
          locale={data.locale}
        />
        <Choices
          id="key"
          name="capabilities"
          type="checkbox"
          legend={t('admin.keys.create.capabilities')}
          locale={data.locale}
          options={options(data.keyCapabilities)}
          optionLabel={choice}
        />
        <p class="ui-hint">{t('admin.keys.create.hint')}</p>
        <Actions>
          <Button>{t('admin.keys.create.submit')}</Button>
        </Actions>
      </Card>
    </form>
  </section>
</main>
