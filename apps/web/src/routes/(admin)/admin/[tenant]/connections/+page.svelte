<!-- The connections of a site (brief admin-operations-screens § 8, #82 PR 3) on the overview
     pattern: a table that stacks below 36rem with name, provider, stand and last activity, each
     name a link to the connection's own page where every action lives; an empty state that says
     what a connection is, under the plug icon. Adding a webhook is the primary action: a native
     <details> whose summary looks like the primary button, above the list or, while there is
     none, in the empty state (#116); its form lands on the new connection's page. What a
     connection is waits behind the ⓘ beside the list heading. Stand and last activity come
     from connection-stand.ts, the same words the detail page uses. e2e/admin.spec.ts checks 320
     CSS px and 200% text. -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Field,
    Notice,
    OverviewPage,
    Table,
  } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { STAND_TONE, lastActivity, standOf } from '#lib/admin/connection-stand.js';
  import { ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const allowed = (capability: string) =>
    data.capabilities.includes(capability as (typeof data.capabilities)[number]) ||
    data.capabilities.includes('tenant:admin');
  const failed = $derived(form && 'error' in form ? form : null);

  const now = $derived(new Date(data.now));
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
  const list = $derived(
    data.connections.map((connection) => {
      const intents =
        data.intents.find((group) => group.connectionId === connection.id)?.rows ?? [];
      return { connection, stand: standOf(connection, intents), last: lastActivity(intents) };
    })
  );
  const provider = (name: string) => t(`admin.connections.provider.${name}` as UiKey);
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.connections.title')} · {data.tenant
      .name}</title
  >
</svelte:head>

<OverviewPage
  title={t('admin.connections.title')}
  locale={data.locale}
  breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.connections.title') }]}
  description={t('admin.connections.intro')}
  listTitle={t('admin.connections.inventory')}
  listInfo={t('admin.connections.info')}
  empty={list.length === 0
    ? {
        title: t('admin.connections.empty.title'),
        body: t('admin.connections.empty.body'),
        icon: 'plug',
        action: addFirst,
      }
    : undefined}
>
  {#snippet notices()}
    {#if failed}
      <Notice tone="error" title={t('error.summary.title')}>
        <p>{t(failed.error as UiKey)}</p>
      </Notice>
    {/if}
  {/snippet}

  {#snippet intro()}
    {#if list.length && allowed('connections:configure')}{@render create()}{/if}
  {/snippet}

  <Table
    id="connections-table"
    caption={t('admin.connections.inventory')}
    hideCaption
    stack
    card
    columns={[
      { key: 'name', label: t('admin.connections.col.name') },
      { key: 'provider', label: t('admin.connections.provider') },
      { key: 'stand', label: t('admin.connections.col.stand') },
      { key: 'last', label: t('admin.connections.col.last') },
    ]}
  >
    {#snippet rows()}
      {#each list as row (row.connection.id)}
        <tr>
          <td data-label={t('admin.connections.col.name')}
            ><a href="{base}/connections/{row.connection.id}">{row.connection.purpose}</a></td
          >
          <td data-label={t('admin.connections.provider')}>{provider(row.connection.provider)}</td>
          <td data-label={t('admin.connections.col.stand')}
            ><Badge tone={STAND_TONE[row.stand]}
              >{t(`admin.connections.stand.${row.stand}` as UiKey)}</Badge
            ></td
          >
          <td data-label={t('admin.connections.col.last')}>
            {#if row.last}
              {@const at = when(row.last)}
              <time datetime={at.iso} title={at.full}>{at.text}</time>
            {:else}
              {t('admin.connections.never')}
            {/if}
          </td>
        </tr>
      {/each}
    {/snippet}
  </Table>
</OverviewPage>

{#snippet create()}
  <details class="ui-create" open={!!failed}>
    <summary class="ui-button primary">{t('admin.connections.create.title')}</summary>
    <form method="post" action="?/create" class="ui-fields">
      <Field
        id="create-owner"
        size="m"
        name="externalOwner"
        label={t('admin.connections.owner')}
        locale={data.locale}
        required
        maxlength={160}
      />
      <Field
        id="create-maintainer"
        size="m"
        name="maintainer"
        label={t('admin.connections.maintainer')}
        locale={data.locale}
        required
        maxlength={160}
      />
      <Field
        id="create-purpose"
        name="purpose"
        label={t('admin.connections.purpose')}
        locale={data.locale}
        required
        maxlength={160}
      />
      <Field
        id="create-destination"
        name="destination"
        type="url"
        label={t('admin.connections.destination')}
        locale={data.locale}
        required
        placeholder="https://hooks.example.org/mycel"
      />
      <Field
        id="create-scopes"
        size="m"
        name="consentScopes"
        label={t('admin.connections.scopes')}
        locale={data.locale}
        required
        placeholder="newsletter:main"
      />
      <p class="ui-hint">{t('admin.connections.create.help')}</p>
      <Actions><Button>{t('admin.connections.create.submit')}</Button></Actions>
    </form>
  </details>
{/snippet}

{#snippet addFirst()}
  {#if allowed('connections:configure')}{@render create()}{/if}
{/snippet}
