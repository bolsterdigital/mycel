<!-- Members and access (brief #81 PR 1, nail-brief admin-settings-screens): who works on this site
     and which programs reach it with an API key, laid out per task of an administrator instead
     of per function. The operator's own capabilities are one line on top; members are rows with
     their capabilities as badges, changed in a disclosure in the row and removed with a
     confirmation in the row; invitations not yet used are their own group; inviting and creating
     a key happen in a dialog. A new key's token is shown once, in KeyReveal.
     The server actions are those of the tenant home moved in #66 PR 1, unchanged: every control
     is still a native form post to them, with or without JavaScript (the dialogs are invoker
     buttons, the disclosures <details>). The form wraps the card, not the other way round, so a
     card's buttons share one form via `formaction`. Action groups wrap whole buttons; a long
     label wraps inside its own button at word boundaries (skill ui-action-layout); the UI gate
     measures this page at 320 CSS px and 200% text with every disclosure open (e2e/routes.ts).
     Rejected: a table of members (a row of checkboxes per member does not fit a table cell at
     320 CSS px) and keys on a menu item of their own (nail-brief question 1, advice taken). -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Card,
    Choices,
    ConfirmAction,
    Dialog,
    Field,
    KeyReveal,
    Notice,
    PageHeader,
  } from '#lib/admin/ui/index.js';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));

  /** Lets a long capability break after its colon instead of overflowing a narrow screen. */
  const parts = (capability: string) => capability.split(':');
  const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : null);
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const token = $derived(form && 'token' in form ? form : null);
  const options = (list: readonly string[]) => list.map((c) => ({ value: c, label: c }));
  const vars = (f: Record<string, unknown>) => ({
    email: typeof f.email === 'string' ? f.email : '',
  });
  const active = $derived(data.members.filter((m) => !m.pending));
  const pending = $derived(data.members.filter((m) => m.pending));
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.members.title')} · {data.tenant.name}</title
  >
</svelte:head>

{#snippet capability(name: string)}{parts(name)[0]}:<wbr />{parts(name)[1]}{/snippet}
{#snippet choice(option: { value: string })}{@render capability(option.value)}{/snippet}
{#snippet badges(list: readonly string[])}
  <ul class="ui-badges">
    {#each list as c (c)}<li><Badge>{@render capability(c)}</Badge></li>{/each}
  </ul>
{/snippet}

{#snippet member(m: (typeof data.members)[number])}
  <form method="post" action="?/update" class="ui-card-form">
    <Card title={m.name ? `${m.email} (${m.name})` : m.email}>
      {#if m.pending}
        <ul class="ui-badges">
          <li><Badge tone="warning">{t('admin.members.pending')}</Badge></li>
        </ul>
      {/if}
      {@render badges(m.capabilities)}
      <input type="hidden" name="operatorId" value={m.operatorId} />
      <details class="ui-fold">
        <summary>{t('admin.members.edit')}</summary>
        <Choices
          id="m-{m.operatorId}"
          name="capabilities"
          type="checkbox"
          legend={fill(t('admin.members.capabilities'), { email: m.email })}
          locale={data.locale}
          options={options(data.allCapabilities)}
          selected={m.capabilities}
          optionLabel={choice}
        />
        <Actions>
          <Button>{t('admin.members.save')}</Button>
        </Actions>
      </details>
      {#if m.email !== data.email}
        <Actions>
          <ConfirmAction
            label={t('admin.members.remove')}
            question={t('admin.members.removeQuestion')}
            confirm={t('admin.members.removeConfirm')}
            name={m.email}
            formaction="?/remove"
          />
        </Actions>
      {/if}
    </Card>
  </form>
{/snippet}

<main class="page admin">
  <PageHeader title={t('admin.members.title')} locale={data.locale} />

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
  {#if token}
    <KeyReveal
      id="new-key"
      title="{t('admin.keys.token.title')}: {token.keyName}"
      value={token.token ?? ''}
      locale={data.locale}
    >
      <p>{t('admin.keys.token.body')}</p>
    </KeyReveal>
  {/if}

  <section aria-labelledby="mine">
    <h2 id="mine">{t('admin.yourCapabilities')}</h2>
    {@render badges(data.capabilities)}
  </section>

  <section aria-labelledby="members">
    <h2 id="members">{t('admin.members.title')}</h2>
    <p>{t('admin.members.note')}</p>
    <Actions>
      <Dialog
        id="invite"
        title={t('admin.invite.title')}
        trigger={t('admin.invite.title')}
        variant="primary"
        locale={data.locale}
      >
        <form method="post" action="?/invite" class="ui-fields">
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
            id="invite-capabilities"
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
        </form>
      </Dialog>
    </Actions>
    {#each active as m (m.operatorId)}{@render member(m)}{/each}

    {#if pending.length > 0}
      <h3>{t('admin.members.pendingTitle')}</h3>
      {#each pending as m (m.operatorId)}{@render member(m)}{/each}
    {/if}
  </section>

  <section aria-labelledby="access">
    <h2 id="access">{t('admin.access.title')}</h2>
    <p>{t('admin.access.intro')}</p>
    <Actions>
      <Dialog
        id="create-key"
        title={t('admin.keys.create.title')}
        trigger={t('admin.keys.create.title')}
        variant="primary"
        locale={data.locale}
      >
        <form method="post" action="?/createKey" class="ui-fields">
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
        </form>
      </Dialog>
    </Actions>
    {#if data.keys.length === 0}
      <p>{t('admin.keys.none')}</p>
    {/if}
    {#each data.keys as key (key.id)}
      <form method="post" action="?/revokeKey" class="ui-card-form">
        <Card title={key.name}>
          {#if key.revokedAt}
            <ul class="ui-badges">
              <li><Badge tone="error">{t('admin.keys.revoked')}</Badge></li>
            </ul>
          {/if}
          <div class="ui-meta-host">
            <dl class="ui-meta">
              <div>
                <dt>{t('admin.keys.prefix')}</dt>
                <dd><code>{key.prefix}</code></dd>
              </div>
              <div>
                <dt>{t('admin.keys.capabilities')}</dt>
                <dd>{@render badges(key.capabilities)}</dd>
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
  </section>
</main>
