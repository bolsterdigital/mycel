<!-- The site's hostnames (brief #81 PR 2, nail-brief admin-settings-screens): one row per hostname
     with its kind, primary and verification as badges, the DNS records to set as values to copy,
     and the row's actions: check the DNS again, make primary, and remove with a confirmation in
     the row. Adding a domain happens in a dialog.
     The server actions are those moved from the tenant home in #66 PR 1, unchanged: every control
     is still a native form post to them, with or without JavaScript (the dialog is an invoker
     button, the confirmation a <details>, the copy buttons an enhancement that stays hidden
     without the script). The form wraps the card, not the other way round, so a card's buttons
     share one form via `formaction`. Action groups wrap whole buttons; a long label wraps inside
     its own button at word boundaries (skill ui-action-layout); the UI gate measures this page at
     320 CSS px and 200% text with every disclosure open (e2e/routes.ts).
     Rejected: a table of hostnames (four DNS values and three actions do not fit a table row at
     320 CSS px) and a page per domain (the records and the check belong next to each other). -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Card,
    ConfirmAction,
    CopyField,
    Dialog,
    Field,
    Notice,
    PageHeader,
  } from '#lib/admin/ui/index.js';
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
    <Actions>
      <Dialog
        id="add-domain"
        title={t('admin.domains.add.title')}
        trigger={t('admin.domains.add.title')}
        variant="primary"
        locale={data.locale}
      >
        <form method="post" action="?/addHostname" class="ui-fields">
          <Field
            id="add-hostname"
            name="hostname"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            required
            maxlength={300}
            size="m"
            placeholder={t('admin.domains.add.placeholder')}
            label={t('admin.domains.add.hostname')}
            hint={t('admin.domains.add.hint')}
            hintInline
            locale={data.locale}
            value={failed?.action === 'addHostname' ? (failed.hostname ?? '') : ''}
          />
          <Actions>
            <Button>{t('admin.domains.add.submit')}</Button>
          </Actions>
        </form>
      </Dialog>
    </Actions>
    {#each data.hostnames as h, i (h.hostname)}
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
            <CopyField
              id="dns-{i}-txt-name"
              label="{t('admin.domains.dns.txt')}: {t('admin.domains.dns.name')}"
              value={h.dns.txt.name}
              locale={data.locale}
            />
            <CopyField
              id="dns-{i}-txt-value"
              label="{t('admin.domains.dns.txt')}: {t('admin.domains.dns.value')}"
              value={h.dns.txt.value}
              locale={data.locale}
            />
            <CopyField
              id="dns-{i}-cname-name"
              label="{t('admin.domains.dns.cname')}: {t('admin.domains.dns.name')}"
              value={h.dns.cname.name}
              locale={data.locale}
            />
            <CopyField
              id="dns-{i}-cname-target"
              label="{t('admin.domains.dns.cname')}: {t('admin.domains.dns.target')}"
              value={h.dns.cname.target}
              locale={data.locale}
            />
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
                <ConfirmAction
                  label={t('admin.domains.remove')}
                  question={t('admin.domains.removeQuestion')}
                  confirm={t('admin.domains.removeConfirm')}
                  name={h.hostname}
                  formaction="?/removeHostname"
                />
              {/if}
            </Actions>
          {/if}
        </Card>
      </form>
    {/each}
  </section>
</main>
