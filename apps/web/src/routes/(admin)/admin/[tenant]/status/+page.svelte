<!-- The status page of a site (TODO #17c) on the shared admin components (brief #56): stuck tasks
     with "try again" and "close", mail with an uncertain outcome, the latest actions and the
     diagnosis to share, every action a native form post. Each task is a card with its facts as a
     MetaList and its action group in the card footer; the group wraps whole buttons (skill
     ui-action-layout), e2e/status.spec.ts checks 320 CSS px and 200% text. The diagnosis stands
     on the page as text and in a read-only field to copy from; nothing sends it. An erasure no
     backup holds after an hour (TODO #29B) is a warning above everything else. -->
<script lang="ts">
  import {
    Actions,
    Button,
    Card,
    CardGrid,
    EmptyState,
    Field,
    MetaList,
    Notice,
    PageHeader,
  } from '#lib/admin/ui/index.js';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const status = $derived(data.status);

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const confirming = $derived(form && 'confirm' in form ? form.confirm : null);
  const when = $derived(
    new Intl.DateTimeFormat(data.locale, { dateStyle: 'medium', timeStyle: 'short' })
  );
  const at = (iso: string) => when.format(new Date(iso));
  type Job = (typeof status.jobs)[number];
  type Mail = (typeof status.mails)[number];
  const jobFacts = (job: Job) => [
    { term: t('admin.status.job.key'), value: job.key },
    {
      term: t('admin.status.job.attempts'),
      value: fill(t('admin.status.job.attemptsValue'), {
        attempts: job.attempts,
        max: job.maxAttempts,
      }),
    },
    {
      term: t('admin.status.job.lastError'),
      value: job.lastError ?? t('admin.status.job.noError'),
    },
    { term: t('admin.status.job.created'), value: at(job.createdAt) },
  ];
  const mailFacts = (mail: Mail) => [
    { term: t('admin.status.mail.subscriber'), value: mail.subscriber },
    { term: t('admin.status.job.attempts'), value: String(mail.attempts) },
    { term: t('admin.status.mail.attempted'), value: at(mail.attemptedAt) },
    ...(mail.abandonedAt
      ? [{ term: t('admin.status.mail.abandonedAt'), value: at(mail.abandonedAt) }]
      : []),
    {
      term: t('admin.status.job.lastError'),
      value: mail.lastError ?? t('admin.status.job.noError'),
    },
  ];
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.status.title')} · {data.tenant.name}</title
  >
</svelte:head>

<main class="page admin">
  <PageHeader
    title={t('admin.status.title')}
    locale={data.locale}
    breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.status.title') }]}
  />

  {#if failed}
    <Notice tone="error" title={t('error.summary.title')}><p>{t(failed.error as UiKey)}</p></Notice>
  {/if}
  {#if done}
    <Notice tone="success"><p>{t(done.done as UiKey)}</p></Notice>
  {/if}
  {#if confirming}
    <Notice tone="warning">
      <form method="post" action="?/close" aria-labelledby="close-title">
        <h2 id="close-title">{fill(t('admin.status.close.title'), { type: confirming.type })}</h2>
        <p>{t('admin.status.close.body')}</p>
        <input type="hidden" name="id" value={confirming.id} />
        <input type="hidden" name="confirm" value="yes" />
        <Actions>
          <Button variant="danger">{t('admin.status.close.confirm')}</Button>
          <Button variant="secondary" href="{base}/status">{t('admin.status.close.cancel')}</Button>
        </Actions>
      </form>
    </Notice>
  {/if}

  {#if status.erasures.late && status.erasures.oldestUnsecuredAt}
    <Notice tone="warning" title={t('admin.status.erasures.title')}>
      <p>
        {fill(t('admin.status.erasures.body'), {
          count: String(status.erasures.unsecured),
          time: at(status.erasures.oldestUnsecuredAt),
        })}
      </p>
    </Notice>
  {/if}

  {#if status.jobs.length === 0 && status.mails.length === 0 && !status.erasures.late}
    <EmptyState title={t('admin.status.nothing')} />
  {/if}

  <section aria-labelledby="jobs">
    <h2 id="jobs">{t('admin.status.jobs.title')}</h2>
    <p class="ui-hint">{t('admin.status.jobs.intro')}</p>
    {#if status.jobs.length === 0}
      <p>{t('admin.status.jobs.none')}</p>
    {:else}
      <CardGrid items={status.jobs} key={(job) => job.id}>
        {#snippet card(job)}
          <Card title={job.type}>
            <MetaList items={jobFacts(job)} />
            {#snippet footer()}
              <form method="post">
                <input type="hidden" name="id" value={job.id} />
                <input type="hidden" name="type" value={job.type} />
                <Actions>
                  <Button formaction="?/retry">{t('admin.status.job.retry')}</Button>
                  <Button variant="secondary" formaction="?/close"
                    >{t('admin.status.job.close')}</Button
                  >
                </Actions>
              </form>
            {/snippet}
          </Card>
        {/snippet}
      </CardGrid>
    {/if}
  </section>

  <section aria-labelledby="mail">
    <h2 id="mail">{t('admin.status.mail.title')}</h2>
    <p class="ui-hint">{t('admin.status.mail.intro')}</p>
    {#if status.mails.length === 0}
      <p>{t('admin.status.mail.none')}</p>
    {:else}
      <CardGrid items={status.mails.map((mail, i) => ({ mail, i }))} key={({ i }) => String(i)}>
        {#snippet card({ mail })}
          <Card
            title={t(
              mail.state === 'abandoned'
                ? 'admin.status.mail.abandoned'
                : 'admin.status.mail.unknown'
            )}
          >
            <MetaList items={mailFacts(mail)} />
          </Card>
        {/snippet}
      </CardGrid>
    {/if}
  </section>

  <section aria-labelledby="audit">
    <h2 id="audit">{t('admin.status.audit.title')}</h2>
    {#if status.audit.length === 0}
      <p>{t('admin.status.audit.none')}</p>
    {:else}
      <ol class="audit">
        {#each status.audit as row (row.id)}
          <li>
            {fill(t('admin.status.audit.item'), {
              time: at(row.occurredAt),
              operation: row.operation,
              actor: row.actorId ? `${row.actorKind}:${row.actorId}` : row.actorKind,
              result: row.result,
            })}
          </li>
        {/each}
      </ol>
    {/if}
  </section>

  <section aria-labelledby="diagnosis">
    <h2 id="diagnosis">{t('admin.status.diagnosis.title')}</h2>
    <p class="ui-hint">{t('admin.status.diagnosis.intro')}</p>
    <pre class="diagnosis">{status.diagnosis}</pre>
    <Field id="diagnosis-copy" label={t('admin.status.diagnosis.copy')} locale={data.locale}>
      {#snippet control(attributes)}
        <textarea {...attributes} readonly rows="8">{status.diagnosis}</textarea>
      {/snippet}
    </Field>
  </section>
</main>
