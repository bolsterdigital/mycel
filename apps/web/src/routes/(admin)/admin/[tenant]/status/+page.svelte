<!-- The status page of a site (TODO #17c): stuck tasks with "try again" and "close", mail with an
     uncertain outcome, the latest actions and the diagnosis to share, every action a native form
     post. Each task's action group wraps whole buttons onto a new line when they do not fit
     (skill ui-action-layout); e2e/status.spec.ts checks 320 CSS px and 200% text. The diagnosis
     stands on the page as text and in a read-only field to copy from; nothing sends it. An erasure
     no backup holds after an hour (TODO #29B) is a notice above everything else. -->
<script lang="ts">
  import Header from '#lib/admin/Header.svelte';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const status = $derived(data.status);

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);
  const confirming = $derived(form && 'confirm' in form ? form.confirm : null);
  const when = $derived(
    new Intl.DateTimeFormat(data.locale, { dateStyle: 'medium', timeStyle: 'short' })
  );
  const at = (iso: string) => when.format(new Date(iso));
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.status.title')} · {data.tenant.name}</title
  >
</svelte:head>

<Header locale={data.locale} email={data.email} />
<main class="page admin">
  <h1>{t('admin.status.title')}</h1>
  <p>
    <a href="/admin/{data.tenant.slug}"
      >{fill(t('admin.status.back'), { name: data.tenant.name })}</a
    >
  </p>

  {#if failed}
    <div class="error-summary" role="alert">
      <h2>{t('error.summary.title')}</h2>
      <p>{t(failed.error as UiKey)}</p>
    </div>
  {/if}
  {#if done}
    <div class="notice" role="status">
      <p>{t(done.done as UiKey)}</p>
    </div>
  {/if}
  {#if confirming}
    <form method="post" action="?/close" class="notice" aria-labelledby="close-title">
      <h2 id="close-title">{fill(t('admin.status.close.title'), { type: confirming.type })}</h2>
      <p>{t('admin.status.close.body')}</p>
      <input type="hidden" name="id" value={confirming.id} />
      <input type="hidden" name="confirm" value="yes" />
      <div class="actions">
        <button type="submit">{t('admin.status.close.confirm')}</button>
        <a class="button secondary" href="/admin/{data.tenant.slug}/status">
          {t('admin.status.close.cancel')}
        </a>
      </div>
    </form>
  {/if}

  {#if status.erasures.late && status.erasures.oldestUnsecuredAt}
    <section class="notice" aria-labelledby="erasures">
      <h2 id="erasures">{t('admin.status.erasures.title')}</h2>
      <p>
        {fill(t('admin.status.erasures.body'), {
          count: String(status.erasures.unsecured),
          time: at(status.erasures.oldestUnsecuredAt),
        })}
      </p>
    </section>
  {/if}

  {#if status.jobs.length === 0 && status.mails.length === 0 && !status.erasures.late}
    <p>{t('admin.status.nothing')}</p>
  {/if}

  <section aria-labelledby="jobs">
    <h2 id="jobs">{t('admin.status.jobs.title')}</h2>
    <p class="muted">{t('admin.status.jobs.intro')}</p>
    {#if status.jobs.length === 0}
      <p>{t('admin.status.jobs.none')}</p>
    {/if}
    {#each status.jobs as job (job.id)}
      <article class="card" aria-labelledby="job-{job.id}">
        <h3 id="job-{job.id}">{job.type}</h3>
        <dl>
          <dt>{t('admin.status.job.key')}</dt>
          <dd><code>{job.key}</code></dd>
          <dt>{t('admin.status.job.attempts')}</dt>
          <dd>
            {fill(t('admin.status.job.attemptsValue'), {
              attempts: job.attempts,
              max: job.maxAttempts,
            })}
          </dd>
          <dt>{t('admin.status.job.lastError')}</dt>
          <dd>{job.lastError ?? t('admin.status.job.noError')}</dd>
          <dt>{t('admin.status.job.created')}</dt>
          <dd><time datetime={job.createdAt}>{at(job.createdAt)}</time></dd>
        </dl>
        <form method="post" class="actions">
          <input type="hidden" name="id" value={job.id} />
          <input type="hidden" name="type" value={job.type} />
          <button type="submit" formaction="?/retry">{t('admin.status.job.retry')}</button>
          <button type="submit" formaction="?/close" class="secondary">
            {t('admin.status.job.close')}
          </button>
        </form>
      </article>
    {/each}
  </section>

  <section aria-labelledby="mail">
    <h2 id="mail">{t('admin.status.mail.title')}</h2>
    <p class="muted">{t('admin.status.mail.intro')}</p>
    {#if status.mails.length === 0}
      <p>{t('admin.status.mail.none')}</p>
    {/if}
    {#each status.mails as mail, i (i)}
      <article class="card" aria-labelledby="mail-{i}">
        <h3 id="mail-{i}">
          {t(
            mail.state === 'abandoned' ? 'admin.status.mail.abandoned' : 'admin.status.mail.unknown'
          )}
        </h3>
        <dl>
          <dt>{t('admin.status.mail.subscriber')}</dt>
          <dd><code>{mail.subscriber}</code></dd>
          <dt>{t('admin.status.job.attempts')}</dt>
          <dd>{mail.attempts}</dd>
          <dt>{t('admin.status.mail.attempted')}</dt>
          <dd><time datetime={mail.attemptedAt}>{at(mail.attemptedAt)}</time></dd>
          {#if mail.abandonedAt}
            <dt>{t('admin.status.mail.abandonedAt')}</dt>
            <dd><time datetime={mail.abandonedAt}>{at(mail.abandonedAt)}</time></dd>
          {/if}
          <dt>{t('admin.status.job.lastError')}</dt>
          <dd>{mail.lastError ?? t('admin.status.job.noError')}</dd>
        </dl>
      </article>
    {/each}
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
    <p class="muted">{t('admin.status.diagnosis.intro')}</p>
    <pre class="diagnosis">{status.diagnosis}</pre>
    <div class="field">
      <label for="diagnosis-copy">{t('admin.status.diagnosis.copy')}</label>
      <textarea id="diagnosis-copy" readonly rows="8">{status.diagnosis}</textarea>
    </div>
  </section>
</main>
