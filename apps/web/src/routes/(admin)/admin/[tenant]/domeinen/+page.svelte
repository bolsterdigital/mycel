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
     An organisation's main domain (#115) is added as both of its names, `example.org` and
     `www.example.org`, and shown as one card: per name its own DNS records (an ALIAS for the bare
     name, which cannot take a CNAME, a CNAME for www), one check for both, and once both are
     verified the choice which is the site's address; the other then redirects (the existing
     primary). A separate subdomain is one name with a CNAME and no word about www.
     Rejected: a table of hostnames (four DNS values and three actions do not fit a table row at
     320 CSS px) and a page per domain (the records and the check belong next to each other). -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Card,
    Choices,
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
  const verifies = $derived(form && 'verifies' in form ? form.verifies : []);
  type Entry = (typeof data.entries)[number];
  type Name = Extract<Entry, { kind: 'single' }>['hostname'];
  const label = (h: Name) =>
    h.display !== h.hostname ? `${h.display} (${h.hostname})` : h.display;
  /** A bare name of two labels is never a subdomain: its CNAME is not allowed at most providers. */
  const bare = (h: Name) => h.hostname.split('.').length === 2;
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
  {#each verifies as verify (verify.hostname)}
    {#if !verify.checked}
      <Notice tone="warning">
        <p>{fill(t('admin.domains.done.unavailable'), { hostname: verify.hostname })}</p>
      </Notice>
    {:else}
      <Notice tone={verify.verified ? 'success' : 'warning'}>
        <p>
          {fill(
            t(verify.verified ? 'admin.domains.done.verified' : 'admin.domains.done.notVerified'),
            { hostname: verify.hostname }
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
  {/each}
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
          <Choices
            id="add-scope"
            name="scope"
            legend={t('admin.domains.add.scope')}
            locale={data.locale}
            required
            options={[
              { value: 'main', label: t('admin.domains.add.scope.main') },
              { value: 'sub', label: t('admin.domains.add.scope.sub') },
            ]}
            selected={failed?.action === 'addHostname' && 'scope' in failed && failed.scope
              ? [String(failed.scope)]
              : []}
          />
          <Actions>
            <Button>{t('admin.domains.add.submit')}</Button>
          </Actions>
        </form>
      </Dialog>
    </Actions>
    {#each data.entries as entry, i (entry.kind === 'pair' ? entry.apex.hostname : entry.hostname.hostname)}
      {#if entry.kind === 'single'}
        {@const h = entry.hostname}
        <form
          method="post"
          action={h.kind === 'custom' ? '?/verifyHostname' : '?/setPrimaryHostname'}
          class="ui-card-form"
        >
          <Card title={label(h)}>
            {@render state(h, true)}
            {#if h.dns}
              <h4>{t('admin.domains.dns.title')}</h4>
              {@render records(h, `${i}`, bare(h) ? 'apex' : 'cname')}
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
      {:else}
        {@const { apex, www } = entry}
        <form method="post" action="?/verifyHostname" class="ui-card-form">
          <Card title={label(apex)}>
            <ul class="ui-badges">
              <li><Badge>{t('admin.domains.kind.main')}</Badge></li>
            </ul>
            <p>
              {apex.primary
                ? fill(t('admin.domains.pair.redirects'), { from: www.display, to: apex.display })
                : www.primary
                  ? fill(t('admin.domains.pair.redirects'), { from: apex.display, to: www.display })
                  : t(
                      apex.verifiedAt && www.verifiedAt
                        ? 'admin.domains.pair.choose'
                        : 'admin.domains.pair.later'
                    )}
            </p>
            {#each [apex, www] as h, j (h.hostname)}
              <h4>{label(h)}</h4>
              {@render state(h, false)}
              {#if h.dns}{@render records(h, `${i}-${j}`, j === 0 ? 'apex' : 'cname')}{/if}
              <input type="hidden" name="hostname" value={h.hostname} />
              <!-- Under the name it is about, with that name only in the accessible name: a
                   hostname is one word a button cannot break at 320 CSS px and 200% text. -->
              {#if h.verifiedAt && !h.primary}
                <Actions>
                  <Button
                    variant="secondary"
                    formaction="?/setPrimaryHostname"
                    name="primary"
                    value={h.hostname}
                    aria-label={`${t('admin.domains.pair.useAs')}: ${h.display}`}
                    >{t('admin.domains.pair.useAs')}</Button
                  >
                </Actions>
              {/if}
            {/each}
            <Actions>
              <Button formaction="?/verifyHostname">{t('admin.domains.checkBoth')}</Button>
              {#if !apex.primary && !www.primary}
                <ConfirmAction
                  label={t('admin.domains.remove')}
                  question={t('admin.domains.pair.removeQuestion')}
                  confirm={t('admin.domains.removeConfirm')}
                  name={apex.hostname}
                  formaction="?/removeHostname"
                />
              {/if}
            </Actions>
          </Card>
        </form>
      {/if}
    {/each}
  </section>
</main>

{#snippet state(h: Name, kind: boolean)}
  <ul class="ui-badges">
    {#if kind}
      <li>
        <Badge
          >{t(
            h.kind === 'platform' ? 'admin.domains.kind.platform' : 'admin.domains.kind.custom'
          )}</Badge
        >
      </li>
    {/if}
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
            t(h.checkFailures > 0 ? 'admin.domains.checks.failing' : 'admin.domains.checks.ok'),
            { when: when(h.lastCheckedAt) ?? '', n: h.checkFailures }
          )}
    </p>
  {/if}
{/snippet}

{#snippet records(h: Name, key: string, pointer: 'apex' | 'cname')}
  {@const dns = h.dns!}
  {@const kind = t(pointer === 'apex' ? 'admin.domains.dns.alias' : 'admin.domains.dns.cname')}
  <CopyField
    id="dns-{key}-txt-name"
    label="{t('admin.domains.dns.txt')}: {t('admin.domains.dns.name')}"
    value={dns.txt.name}
    locale={data.locale}
  />
  <CopyField
    id="dns-{key}-txt-value"
    label="{t('admin.domains.dns.txt')}: {t('admin.domains.dns.value')}"
    value={dns.txt.value}
    locale={data.locale}
  />
  <CopyField
    id="dns-{key}-cname-name"
    label="{kind}: {t('admin.domains.dns.name')}"
    value={dns.cname.name}
    locale={data.locale}
  />
  <CopyField
    id="dns-{key}-cname-target"
    label="{kind}: {t('admin.domains.dns.target')}"
    value={dns.cname.target}
    locale={data.locale}
  />
  {#if pointer === 'apex'}<p class="ui-hint">{t('admin.domains.dns.apex')}</p>{/if}
{/snippet}
