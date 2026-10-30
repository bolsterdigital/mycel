<!-- Members (#81 PR 1, reshaped by #101): who works on this site, as a table
     with the name on the left and the role next to it, actions in the row. A role is a preset
     over the capability set (core operators/roles.ts); a set that matches none reads "Custom"
     with the set behind an ⓘ. Invitations not yet used are the same table under a group heading;
     you are an ordinary row marked "(you)", without Remove. Your own role per site is on
     "Profile and preferences", API keys on Settings, API access.
     Every control is a native form post, with or without JavaScript: inviting and changing a
     role happen in a dialog (an invoker button), removing asks in the row. On a narrow screen the
     table stacks its rows (Table `stack`); the UI gate measures this page at 320 CSS px and 200%
     text (e2e/routes.ts). Rejected: a `⋯` menu for the row actions on a narrow screen (two
     actions stack as whole buttons, a menu would hide them behind one more step). -->
<script lang="ts">
  import type { Role } from '@mycel/core';
  import {
    Actions,
    Badge,
    Button,
    ConfirmAction,
    Dialog,
    Field,
    HintButton,
    Notice,
    PageHeader,
    RolePicker,
    Table,
  } from '#lib/admin/ui/index.js';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const vars = (f: Record<string, unknown>) => ({
    email: typeof f.email === 'string' ? f.email : '',
  });
  const active = $derived(data.members.filter((m) => !m.pending));
  const pending = $derived(data.members.filter((m) => m.pending));
  const roleName = (role: Role) => t(`admin.role.${role}` as UiKey);
  const columns = $derived([
    { key: 'name', label: t('admin.members.column.name') },
    { key: 'role', label: t('admin.members.column.role') },
    { key: 'actions', label: t('admin.members.column.actions') },
  ]);
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.members.title')} · {data.tenant.name}</title
  >
</svelte:head>

{#snippet member(m: (typeof data.members)[number])}
  {@const self = m.email === data.email}
  <tr>
    <th scope="row">
      {m.name ?? m.email}{#if self}
        {t('admin.members.you')}{/if}
      {#if m.name}<br /><span class="ui-hint">{m.email}</span>{/if}
    </th>
    <td data-label={t('admin.members.column.role')}>
      <span id="role-{m.operatorId}">{roleName(m.role)}</span>
      {#if m.role === 'custom'}
        <HintButton
          target="set-{m.operatorId}"
          labelId="role-{m.operatorId}"
          locale={data.locale}
        />
        <p class="ui-hint" id="set-{m.operatorId}" popover>{m.capabilities.join(', ')}</p>
      {/if}
      {#if m.pending}<Badge tone="warning">{t('admin.members.pending')}</Badge>{/if}
    </td>
    <td>
      <Actions>
        <Dialog
          id="change-{m.operatorId}"
          title={fill(t('admin.members.roleOf'), { email: m.email })}
          trigger={t('admin.members.changeRole')}
          locale={data.locale}
        >
          <form method="post" action="?/update" class="ui-fields">
            <input type="hidden" name="operatorId" value={m.operatorId} />
            <RolePicker
              id="m-{m.operatorId}"
              locale={data.locale}
              roles={data.roles}
              capabilities={data.allCapabilities}
              role={m.role}
              selected={m.capabilities}
            />
            <Actions>
              <Button>{t('admin.members.save')}</Button>
            </Actions>
          </form>
        </Dialog>
        {#if !self}
          <form method="post" action="?/remove">
            <input type="hidden" name="operatorId" value={m.operatorId} />
            <ConfirmAction
              label={t('admin.members.remove')}
              question={t('admin.members.removeQuestion')}
              confirm={t('admin.members.removeConfirm')}
              name={m.email}
            />
          </form>
        {/if}
      </Actions>
    </td>
  </tr>
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

  <p>{t('admin.members.note')}</p>
  <p id="access">
    <a href="{base}/site?section=api">{t('admin.members.keysMoved')}</a>
  </p>
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
        <RolePicker
          id="invite"
          locale={data.locale}
          roles={data.roles}
          capabilities={data.allCapabilities}
        />
        <p class="ui-hint">{fill(t('admin.invite.hint'), { url: data.loginUrl })}</p>
        <Actions>
          <Button>{t('admin.invite.submit')}</Button>
        </Actions>
      </form>
    </Dialog>
  </Actions>

  <Table id="members" caption={t('admin.members.title')} hideCaption stack {columns}>
    {#snippet rows()}
      {#each active as m (m.operatorId)}{@render member(m)}{/each}
      {#if pending.length > 0}
        <tr>
          <th scope="colgroup" colspan="3">{t('admin.members.pendingTitle')}</th>
        </tr>
        {#each pending as m (m.operatorId)}{@render member(m)}{/each}
      {/if}
    {/snippet}
  </Table>
</main>
