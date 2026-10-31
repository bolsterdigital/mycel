<!-- The status page of a site (brief admin-operations-screens § 1-3, 6, 9): it opens with the
     verdict from `ops.status.get` and the moment it was checked, then the waiting work in words,
     then what asks for attention with its recovery in the row, the erasure requests, the latest
     actions and, folded, the diagnosis to share. Technical types and keys stay behind "Technical
     details". Closing asks first in the row itself (ConfirmAction), with and without JavaScript.
     The verdict and the lists are one region the refresh script replaces every minute; when a
     refresh fails or access is gone it says so beside the old verdict and marks it unknown, so a
     failed refresh never reads as "Everything is running". Without JavaScript "Refresh" is a
     link. Mail per day lists only the days of the last fourteen with mail, newest first, as a
     table that stacks below 36rem. The action groups wrap whole buttons (skill ui-action-layout); e2e/admin.spec.ts checks
     320 CSS px and 200% text. Rejected: cards per task (the reader scans a list, #82) and a
     confirmation above the page (it left the row it acts on). -->
<script lang="ts">
  import {
    Actions,
    Button,
    ConfirmAction,
    Field,
    MetaList,
    Notice,
    PageHeader,
    StatusSummary,
    Table,
  } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { actorLabel, operationKey, resultKey } from '#lib/admin/audit-words.js';
  import { fill, ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const status = $derived(data.status);

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form ? form : null);

  const now = $derived(new Date(status.verdict.checkedAt));
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });

  /** Job types with a name in the catalogue; any other type is "other". */
  const NAMED = new Set([
    'content.publish',
    'mail.reconcile',
    'tenant.export',
    'media.purge',
    'hostnames.reverify',
    'connections.run',
    'assist.run',
  ]);
  const named = (type: string) => (NAMED.has(type) ? type : 'other');
  const taskName = (type: string) => t(`admin.status.task.${named(type)}` as UiKey);
  const count = (key: string, n: number) =>
    fill(t(`${key}.${n === 1 ? 'one' : 'many'}` as UiKey), { count: String(n) });

  const ANCHOR = { job: '#jobs', mail: '#mail', erasure: '#erasures' } as const;
  const attention = $derived(
    status.verdict.attention.map(({ kind, count: n }) => ({
      label: count(`admin.status.attention.${kind}`, n),
      action: t(`admin.status.attention.${kind}.action` as UiKey),
      href: ANCHOR[kind],
    }))
  );
  const verdictTitle = $derived(
    status.verdict.state === 'ok'
      ? t('admin.status.verdict.ok')
      : count('admin.status.verdict', attention.length)
  );

  /** Waiting work per named kind; unnamed types together as "other tasks". */
  const waiting = $derived.by(() => {
    const byKind = new Map<string, { count: number; next: string }>();
    for (const w of status.waiting) {
      const kind = named(w.type);
      const seen = byKind.get(kind);
      if (!seen) byKind.set(kind, { count: w.count, next: w.nextRunAt });
      else {
        seen.count += w.count;
        if (w.nextRunAt < seen.next) seen.next = w.nextRunAt;
      }
    }
    return [...byKind].map(([kind, w]) => ({
      kind,
      label: t(`admin.status.kind.${kind}` as UiKey),
      count: w.count,
      next: new Date(w.next) > now ? when(w.next) : null,
    }));
  });
  const operationWords = (op: string) => {
    const key = operationKey(op);
    return key ? t(key) : op;
  };
  /** The days with mail, newest first; a day name in the admin's language, read in UTC. */
  const mailDays = $derived(
    status.mailDays
      .filter((d) => d.sent + d.unknown + d.abandoned > 0)
      .reverse()
      .map((d) => ({
        ...d,
        label: new Intl.DateTimeFormat(data.locale, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        }).format(new Date(`${d.day}T12:00:00Z`)),
      }))
  );
  const settling = $derived(status.mails.filter((m) => m.state === 'unknown').length);

  type Job = (typeof status.jobs)[number];
  type Mail = (typeof status.mails)[number];
  const jobDetails = (job: Job) => [
    { term: t('admin.status.job.type'), value: job.type },
    { term: t('admin.status.job.key'), value: job.key },
    {
      term: t('admin.status.job.attempts'),
      value: fill(t('admin.status.job.attemptsValue'), {
        attempts: job.attempts,
        max: job.maxAttempts,
      }),
    },
    { term: t('admin.status.job.created'), value: when(job.createdAt).full },
  ];
  const mailFacts = (mail: Mail) => [
    { term: t('admin.status.mail.subscriber'), value: mail.subscriber },
    { term: t('admin.status.job.attempts'), value: String(mail.attempts) },
    { term: t('admin.status.mail.attempted'), value: when(mail.attemptedAt).full },
    ...(mail.abandonedAt
      ? [{ term: t('admin.status.mail.abandonedAt'), value: when(mail.abandonedAt).full }]
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
  <script type="module" src="/_admin/status-refresh.js"></script>
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

  <div class="status-live" data-status-live data-unknown={t('admin.status.verdict.unknown')}>
    <StatusSummary
      id="verdict"
      title={verdictTitle}
      tone={status.verdict.state}
      checked={when(status.verdict.checkedAt)}
      checkedLabel={t('admin.status.checked')}
      items={attention}
    >
      <p class="status-refresh">
        <Button variant="secondary" href="{base}/status" data-status-refresh
          >{t('admin.status.refresh')}</Button
        >
        <span class="ui-hint" data-status-note="auto" hidden>{t('admin.status.refresh.auto')}</span>
      </p>
      <p class="status-note" data-status-note="failed" role="alert" hidden>
        {t('admin.status.refresh.failed')}
      </p>
      <p class="status-note" data-status-note="forbidden" role="alert" hidden>
        {t('admin.status.refresh.forbidden')}
      </p>
    </StatusSummary>

    <section aria-labelledby="waiting">
      <h2 id="waiting">{t('admin.status.waiting.title')}</h2>
      <p class="ui-hint">{t('admin.status.waiting.intro')}</p>
      {#if waiting.length === 0 && settling === 0}
        <p>{t('admin.status.waiting.none')}</p>
      {:else}
        <ul class="status-waiting">
          {#each waiting as w (w.kind)}
            <li>
              {fill(t('admin.status.waiting.item'), { label: w.label, count: String(w.count) })}
              {#if w.next}
                <span class="ui-hint"
                  >({t('admin.status.waiting.next')}
                  <time datetime={w.next.iso} title={w.next.full}>{w.next.text}</time>)</span
                >
              {/if}
            </li>
          {/each}
          {#if settling}
            <li>
              {fill(t('admin.status.waiting.item'), {
                label: t('admin.status.waiting.mail'),
                count: String(settling),
              })}
            </li>
          {/if}
        </ul>
      {/if}
    </section>

    <section aria-labelledby="jobs-title" id="jobs">
      <h2 id="jobs-title">{t('admin.status.jobs.title')}</h2>
      <p class="ui-hint">{t('admin.status.jobs.intro')}</p>
      {#if status.jobs.length === 0}
        <p>{t('admin.status.jobs.none')}</p>
      {:else}
        <ul class="status-rows">
          {#each status.jobs as job (job.id)}
            {@const name = taskName(job.type)}
            <li class="status-row" data-job={job.id}>
              <form method="post" action="?/retry">
                <h3>{name}</h3>
                <p>{fill(t('admin.status.job.summary'), { attempts: job.attempts })}</p>
                <p>
                  {t('admin.status.job.lastError')}: {job.lastError ??
                    t('admin.status.job.noError')}
                </p>
                <input type="hidden" name="id" value={job.id} />
                <Actions>
                  <Button aria-label="{t('admin.status.job.retry')}: {name}"
                    >{t('admin.status.job.retry')}</Button
                  >
                  <ConfirmAction
                    label={t('admin.status.job.close')}
                    question={t('admin.status.close.body')}
                    confirm={t('admin.status.close.confirm')}
                    {name}
                    formaction="?/close"
                    field={{ name: 'confirm', value: 'yes' }}
                  />
                </Actions>
                <details class="ui-fold">
                  <summary>{t('admin.status.job.details')}</summary>
                  <MetaList items={jobDetails(job)} />
                </details>
              </form>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section aria-labelledby="mail-title" id="mail">
      <h2 id="mail-title">{t('admin.status.mail.title')}</h2>
      <p class="ui-hint">{t('admin.status.mail.intro')}</p>
      {#if status.mails.length === 0}
        <p>{t('admin.status.mail.none')}</p>
      {:else}
        <ul class="status-rows">
          {#each status.mails as mail, i (i)}
            <li class="status-row">
              <h3>
                {t(
                  mail.state === 'abandoned'
                    ? 'admin.status.mail.abandoned'
                    : 'admin.status.mail.unknown'
                )}
              </h3>
              <MetaList items={mailFacts(mail)} />
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section aria-labelledby="mail-days-title" id="mail-days">
      <h2 id="mail-days-title">{t('admin.status.mailDays.title')}</h2>
      <p class="ui-hint">{t('admin.status.mailDays.intro')}</p>
      {#if mailDays.length === 0}
        <p>{t('admin.status.mailDays.none')}</p>
      {:else}
        <Table
          id="mail-days-table"
          caption={t('admin.status.mailDays.title')}
          hideCaption
          stack
          columns={[
            { key: 'day', label: t('admin.status.mailDays.day') },
            { key: 'sent', label: t('admin.status.mailDays.sent'), numeric: true },
            { key: 'unknown', label: t('admin.status.mailDays.unknown'), numeric: true },
            { key: 'abandoned', label: t('admin.status.mailDays.abandoned'), numeric: true },
          ]}
        >
          {#snippet rows()}
            {#each mailDays as d (d.day)}
              <tr>
                <td data-label={t('admin.status.mailDays.day')}
                  ><time datetime={d.day}>{d.label}</time></td
                >
                <td data-label={t('admin.status.mailDays.sent')} class="numeric">{d.sent}</td>
                <td data-label={t('admin.status.mailDays.unknown')} class="numeric">{d.unknown}</td>
                <td data-label={t('admin.status.mailDays.abandoned')} class="numeric"
                  >{d.abandoned}</td
                >
              </tr>
            {/each}
          {/snippet}
        </Table>
      {/if}
    </section>

    <section aria-labelledby="erasures-title" id="erasures">
      <h2 id="erasures-title">{t('admin.status.erasures.section')}</h2>
      {#if status.erasures.late && status.erasures.oldestUnsecuredAt}
        <Notice tone="warning" title={t('admin.status.erasures.title')}>
          <p>
            {fill(t('admin.status.erasures.body'), {
              count: String(status.erasures.unsecured),
              time: when(status.erasures.oldestUnsecuredAt).full,
            })}
          </p>
        </Notice>
      {:else if status.erasures.registered === 0}
        <p>{t('admin.status.erasures.none')}</p>
      {:else}
        <p>
          {fill(t('admin.status.erasures.state'), {
            registered: String(status.erasures.registered),
            unsecured: String(status.erasures.unsecured),
          })}
        </p>
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
                time: when(row.occurredAt).text,
                operation: operationWords(row.operation),
                actor: actorLabel(t, row, {}),
                result: t(resultKey(row.result)),
              })}
            </li>
          {/each}
        </ol>
      {/if}
      <p><a href="{base}/status/audit">{t('admin.audit.all')}</a></p>
    </section>

    <section aria-labelledby="diagnosis">
      <h2 id="diagnosis">{t('admin.status.diagnosis.title')}</h2>
      <p class="ui-hint">{t('admin.status.diagnosis.intro')}</p>
      <details class="ui-fold">
        <summary>{t('admin.status.diagnosis.open')}</summary>
        <pre class="diagnosis">{status.diagnosis}</pre>
        <Field id="diagnosis-copy" label={t('admin.status.diagnosis.copy')} locale={data.locale}>
          {#snippet control(attributes)}
            <textarea {...attributes} readonly rows="8">{status.diagnosis}</textarea>
          {/snippet}
        </Field>
      </details>
    </section>
  </div>
</main>
