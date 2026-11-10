<!-- Complete native form administration uses the same registry boundaries as every front. -->
<script lang="ts">
  import { Actions, Button, Checkbox, Field, Notice, PageHeader } from '#lib/admin/ui/index.js';
  import Definition from '#lib/admin/forms/Definition.svelte';
  import Mail from '#lib/admin/forms/Mail.svelte';
  import Feeds from '#lib/admin/forms/Feeds.svelte';
  import { ui, refusalCopy, type UiKey } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const definition = $derived(data.definition.form);
  const allowed = (c: string) =>
    data.capabilities.includes(c as (typeof data.capabilities)[number]) ||
    data.capabilities.includes('tenant:admin');
  const preview = $derived(form && 'preview' in form ? form.preview : null);
</script>

<svelte:head><title>{t('admin.forms.title')} · {definition.list}</title></svelte:head>
<main class="page admin">
  <PageHeader
    title={t('admin.forms.title')}
    locale={data.locale}
    description={t('admin.forms.intro')}
    breadcrumb={[
      { label: t('admin.forms.title'), href: `/admin/${data.tenant.slug}/forms` },
      { label: definition.list },
    ]}
  />
  {#if form && 'error' in form}<Notice tone="error" title={t('error.summary.title')}
      ><p>{refusalCopy(t, form)}</p></Notice
    >{:else if form && 'done' in form}<Notice tone="success"><p>{t('admin.forms.saved')}</p></Notice
    >{/if}
  <Definition
    form={definition}
    version={data.definition.version}
    locale={data.locale}
    editable={allowed('content:publish')}
  />
  {#if data.mail}<Mail
      form={definition}
      state={data.mail}
      locale={data.locale}
      editable={allowed('mailing:send')}
    />{/if}
  {#if data.feeds}<Feeds
      form={definition}
      state={data.feeds.state}
      availability={data.feeds.availability}
      connections={data.connections}
      locale={data.locale}
      editable={allowed('connections:configure')}
    />{/if}
  <section>
    <h2>{t('admin.forms.preview')}</h2>
    <p>{t('admin.forms.rehearsal')}</p>
    <form method="post" action="?/preview" class="ui-fields">
      <Field id="sample-locale" label={t('admin.forms.locale')} locale={data.locale}
        >{#snippet control(a)}<select {...a} name="locale"
            >{#each Object.keys(definition.thankYou) as locale}<option value={locale}
                >{locale}</option
              >{/each}</select
          >{/snippet}</Field
      >
      {#each definition.fields as f}
        {#if ['checkbox', 'consent'].includes(f.type)}<Checkbox
            id="sample-{f.name}"
            name="sample.{f.name}"
            label={f.name}
          />
        {:else if f.type === 'choice' || f.type === 'multiple-choice'}
          <Field id="sample-{f.name}" label={f.name} locale={data.locale}
            >{#snippet control(a)}<select
                {...a}
                name="sample.{f.name}"
                multiple={f.type === 'multiple-choice'}
                >{#each f.options as o}<option value={o.value}>{o.value}</option>{/each}</select
              >{/snippet}</Field
          >
        {:else}<Field
            id="sample-{f.name}"
            name="sample.{f.name}"
            label={f.name}
            locale={data.locale}
            value={f.type === 'hidden' ? f.value : ''}
          />{/if}
      {/each}
      <Actions><Button>{t('admin.forms.preview')}</Button></Actions>
    </form>
    {#if preview?.mail}
      {#if preview.mail.confirmation}{@render message(
          'confirmation',
          preview.mail.confirmation
        )}{/if}
      {#each preview.mail.actions as action}<article>
          <h3>
            {action.actionId}: {t(action.matches ? 'admin.forms.matches' : 'admin.forms.noMatch')}
          </h3>
          {@render message(action.actionId, action.copy)}
        </article>{/each}
    {/if}
    {#each preview?.feeds ?? [] as feed}<p>
        {feed.id}: {feed.failure ?? t(feed.matches ? 'admin.forms.matches' : 'admin.forms.noMatch')}
      </p>{/each}
  </section>
  <section>
    <h2>{t('admin.forms.status')}</h2>
    {#if !data.submissions.length}<p>{t('admin.forms.empty')}</p>{/if}
    {#each data.submissions as submission}
      <details>
        <summary
          ><time datetime={submission.createdAt}>{submission.createdAt}</time> · {submission.id}</summary
        >
        <p>{t(submission.confirmed ? 'admin.forms.confirmed' : 'admin.forms.unconfirmed')}</p>
        {#each data.deliveries.find((d) => d.submissionId === submission.id)?.actions ?? [] as action}
          <article>
            <h3>{action.actionId}</h3>
            <p>
              {t(`admin.forms.${action.state}` as const)} · {t('admin.forms.attempts')}: {action.attempts}
            </p>
            {#if action.lastError}<p>{action.lastError}</p>{/if}
            <p>{action.version}</p>
            {#if allowed('mailing:send') && action.state !== 'sent' && action.state !== 'abandoned'}
              <form method="post" action="?/replay">
                <input type="hidden" name="submissionId" value={submission.id} /><input
                  type="hidden"
                  name="eventId"
                  value={action.eventId}
                /><Actions><Button>{t('admin.forms.replay')}</Button></Actions>
              </form>
            {/if}
          </article>
        {/each}
      </details>
    {/each}
  </section>
</main>
{#snippet message(
  id: string,
  copy: {
    subject: string;
    text: string;
    sources: { subject: 'platform' | 'tenant' | 'local'; text: 'platform' | 'tenant' | 'local' };
  }
)}
  <p><strong>{copy.subject}</strong></p>
  <p class="ui-prose">{copy.text}</p>
  <p>
    {t('admin.forms.source')}: {t(`admin.forms.${copy.sources.subject}` as const)}, {t(
      `admin.forms.${copy.sources.text}` as const
    )}
  </p>
{/snippet}
