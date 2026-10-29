<!-- The site's hostnames (TODO #14), moved verbatim from the tenant home when it became the
     dashboard (#66 PR 1); dev turns it into its own screen in #81. Every action is a native form
     post. Action groups wrap whole buttons onto a new line when they do not fit, and a long label
     wraps inside its own button at word boundaries (skill ui-action-layout); the e2e specs check
     320 CSS px and 200% text.
     On the shared basis (brief #56 § C3): page header, notices, and every domain a form around a
     card with its buttons as one `Actions` group. The form wraps the card, not the other way
     round, so a card's buttons share one form via `formaction`. -->
<script lang="ts">
  import { Actions, Badge, Button, Card, Field, Notice, PageHeader } from '#lib/admin/ui/index.js';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));

  const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : null);
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const verify = $derived(form && 'verify' in form ? form.verify : null);
  const vars = (f: Record<string, unknown>) => ({
    hostname: typeof f.hostname === 'string' ? f.hostname : '',
  });
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.domains.title')} · {data.tenant.name}</title
  >
</svelte:head>

<main class="page admin">
  <PageHeader title={t('admin.domains.title')} locale={data.locale} />

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
</main>
