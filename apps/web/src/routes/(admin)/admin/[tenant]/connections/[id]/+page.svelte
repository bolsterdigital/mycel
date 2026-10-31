<!-- One connection (brief admin-operations-screens § 8, #82 PR 3), top to bottom in the order an
     administrator needs it: the stand; delivery with the kill-switch (pause or resume) and a
     synthetic test; the latest attempts as a table that stacks below 36rem, with the
     reconciliation step in the row (replay, or close by hand when Mycel cannot know the
     outcome); the details, folded for editing; the signing secret, write-only; disconnecting,
     confirmed by a second post. Every action is a native form post and nothing secret, no
     payload and no error body is rendered. e2e/admin.spec.ts checks the flow at 320 CSS px and
     200% text. Rejected: tabs per part (the parts are short and a reader scans them in one go)
     and showing the last characters of the secret (the page must never echo any of it). -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Field,
    Fieldset,
    MetaList,
    Notice,
    PageHeader,
    Table,
  } from '#lib/admin/ui/index.js';
  import { page } from '$app/state';
  import { formatWhen } from '#lib/admin/format.js';
  import { STAND_TONE, standOf } from '#lib/admin/connection-stand.js';
  import { ui, type UiKey } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const c = $derived(data.connection);
  const allowed = (capability: string) =>
    data.capabilities.includes(capability as (typeof data.capabilities)[number]) ||
    data.capabilities.includes('tenant:admin');
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const confirming = $derived(form && 'confirm' in form ? form.confirm : null);
  const created = $derived(!form && page.url.searchParams.has('created'));

  const now = $derived(new Date(data.now));
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
  const stand = $derived(standOf(c, data.intents));
  const live = $derived(c.state !== 'disconnected');
  const facts = $derived([
    {
      term: t('admin.connections.provider'),
      value: t(`admin.connections.provider.${c.provider}` as UiKey),
    },
    { term: t('admin.connections.owner'), value: c.externalOwner },
    { term: t('admin.connections.maintainer'), value: c.maintainer },
    { term: t('admin.connections.destination'), value: c.destination ?? '–' },
    { term: t('admin.connections.scopes'), value: c.consentScopes.join(', ') },
  ]);
</script>

<svelte:head>
  <title>{failed ? `${t('error.prefix')} ` : ''}{c.purpose} · {data.tenant.name}</title>
</svelte:head>

<main class="page admin">
  <PageHeader
    title={c.purpose}
    locale={data.locale}
    breadcrumb={[
      { label: data.tenant.name, href: base },
      { label: t('admin.connections.title'), href: `${base}/connections` },
      { label: c.purpose },
    ]}
  />
  <p>
    <Badge tone={STAND_TONE[stand]}>{t(`admin.connections.stand.${stand}` as UiKey)}</Badge>
  </p>

  {#if failed}
    <Notice tone="error" title={t('error.summary.title')}><p>{t(failed.error as UiKey)}</p></Notice>
  {/if}
  {#if done}
    <Notice tone="success"><p>{t(done.done as UiKey)}</p></Notice>
  {/if}
  {#if created}
    <Notice tone="success"><p>{t('admin.connections.created')}</p></Notice>
  {/if}
  {#if confirming}
    <Notice tone="warning">
      <form method="post" action="?/disconnect" aria-labelledby="disconnect-title">
        <h2 id="disconnect-title">{t('admin.connections.disconnect.title')}</h2>
        <p>{t('admin.connections.disconnect.warning')}</p>
        <input type="hidden" name="version" value={confirming.version} />
        <input type="hidden" name="confirm" value="yes" />
        <Actions>
          <Button variant="danger">{t('admin.connections.disconnect.confirm')}</Button>
          <Button variant="secondary" href="{base}/connections/{c.id}"
            >{t('admin.connections.cancel')}</Button
          >
        </Actions>
      </form>
    </Notice>
  {/if}

  <section aria-labelledby="switch-title">
    <h2 id="switch-title">{t('admin.connections.switch.title')}</h2>
    <p>
      {t(
        c.state === 'active'
          ? 'admin.connections.switch.active'
          : c.state === 'paused'
            ? 'admin.connections.switch.paused'
            : 'admin.connections.switch.off'
      )}
    </p>
    {#if live && allowed('connections:configure')}
      <form method="post">
        <input type="hidden" name="version" value={c.version} />
        <Actions>
          {#if c.state === 'active'}
            <Button formaction="?/pause">{t('admin.connections.pause')}</Button>
            <Button variant="secondary" formaction="?/test">{t('admin.connections.test')}</Button>
          {:else}
            <Button formaction="?/resume">{t('admin.connections.resume')}</Button>
          {/if}
        </Actions>
      </form>
    {/if}
  </section>

  <section aria-labelledby="attempts-title">
    <h2 id="attempts-title">{t('admin.connections.health')}</h2>
    {#if data.intents.length === 0}
      <p>{t('admin.connections.noIntents')}</p>
    {:else}
      <Table
        id="attempts-table"
        caption={t('admin.connections.health')}
        hideCaption
        stack
        columns={[
          { key: 'when', label: t('admin.connections.attempts.when') },
          { key: 'outcome', label: t('admin.connections.attempts.outcome') },
          { key: 'copy', label: t('admin.connections.attempts.copy') },
          { key: 'tries', label: t('admin.connections.attempts.tries'), numeric: true },
          { key: 'action', label: t('admin.connections.attempts.action') },
        ]}
      >
        {#snippet rows()}
          {#each data.intents as intent (intent.id)}
            {@const at = when(intent.updatedAt)}
            <tr data-intent={intent.id}>
              <td data-label={t('admin.connections.attempts.when')}
                ><time datetime={at.iso} title={at.full}>{at.text}</time></td
              >
              <td data-label={t('admin.connections.attempts.outcome')}>
                {t(`admin.connections.delivery.${intent.state}` as UiKey)}{intent.failure
                  ? ` · ${intent.failure}`
                  : ''}
                {#if intent.operatorAction === 'resolve'}
                  <p class="ui-hint">{t('admin.connections.unknown.help')}</p>
                {/if}
              </td>
              <td data-label={t('admin.connections.attempts.copy')}
                >{intent.externalCopyAction === null
                  ? t('admin.connections.synthetic')
                  : t(`admin.connections.copy.${intent.externalCopyAction}` as UiKey)}</td
              >
              <td data-label={t('admin.connections.attempts.tries')} class="numeric"
                >{intent.attempts}</td
              >
              <td data-label={t('admin.connections.attempts.action')}>
                {#if allowed('connections:replay') && intent.operatorAction}
                  <form method="post" action="?/{intent.operatorAction}">
                    <input type="hidden" name="id" value={intent.id} />
                    <Button variant="secondary"
                      >{t(`admin.connections.${intent.operatorAction}` as UiKey)}</Button
                    >
                  </form>
                {/if}
              </td>
            </tr>
          {/each}
        {/snippet}
      </Table>
    {/if}
  </section>

  <section aria-labelledby="details-title">
    <h2 id="details-title">{t('admin.connections.details')}</h2>
    <MetaList items={facts} />
    {#if live && allowed('connections:configure')}
      <form method="post" action="?/update" class="ui-fields">
        <input type="hidden" name="version" value={c.version} />
        <Fieldset legend={t('admin.connections.edit')} collapsed>
          <Field
            id="edit-owner"
            size="m"
            name="externalOwner"
            label={t('admin.connections.owner')}
            locale={data.locale}
            required
            maxlength={160}
            value={c.externalOwner}
          />
          <Field
            id="edit-maintainer"
            size="m"
            name="maintainer"
            label={t('admin.connections.maintainer')}
            locale={data.locale}
            required
            maxlength={160}
            value={c.maintainer}
          />
          <Field
            id="edit-purpose"
            name="purpose"
            label={t('admin.connections.purpose')}
            locale={data.locale}
            required
            maxlength={160}
            value={c.purpose}
          />
          <Field
            id="edit-destination"
            name="destination"
            type="url"
            label={t('admin.connections.destination')}
            locale={data.locale}
            required
            value={c.destination ?? ''}
          />
          <Field
            id="edit-scopes"
            size="m"
            name="consentScopes"
            label={t('admin.connections.scopes')}
            locale={data.locale}
            required
            value={c.consentScopes.join(', ')}
          />
          <Actions><Button>{t('admin.connections.save')}</Button></Actions>
        </Fieldset>
      </form>
    {/if}
  </section>

  <section aria-labelledby="secret-title">
    <h2 id="secret-title">{t('admin.connections.secret.title')}</h2>
    <p>
      {t(
        c.credentialStatus === 'connected'
          ? 'admin.connections.secret.set'
          : 'admin.connections.secret.missing'
      )}
    </p>
    {#if live && allowed('connections:credentials')}
      <form method="post" action="?/credential" class="ui-fields">
        <input type="hidden" name="version" value={c.version} />
        <Field
          id="secret"
          size="m"
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
  </section>

  {#if live && allowed('connections:configure')}
    <section aria-labelledby="end-title">
      <h2 id="end-title">{t('admin.connections.end.title')}</h2>
      <p>{t('admin.connections.end.help')}</p>
      <form method="post" action="?/disconnect">
        <input type="hidden" name="version" value={c.version} />
        <Actions>
          <Button variant="danger">{t('admin.connections.disconnect')}</Button>
        </Actions>
      </form>
    </section>
  {/if}
</main>
