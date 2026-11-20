<!-- The launch checklist (MY-262 PR 2, ADR 037): the verdict in one sentence with every check that
     fails or warns linked to the screen where it is fixed (StatusSummary, as on the status page),
     then the three phases, each a Section with "x of y done" and one form. Per step: its status
     and owner as badges, what it is, what Mycel found, its note as text, then the tick (a manual
     step) or the acceptance (a warning), and the note field, owner and applicability behind
     "Adjust", so the row stays calm: 26 open note fields made a page of nine screens. A step that does not apply folds away at the bottom of its phase and counts for nothing.
     Every control is a native form post; the controls of a step are a group named by its title,
     so "Done" is never read without the step it belongs to. The row is a column, not a row of
     actions: checkbox, note and the fold stack at every width (skill ui-action-layout); the one
     action per phase is Save. The UI gate measures this page at 320 CSS px and 200% text with
     every fold open (e2e/routes.ts).
     Rejected: a table (a note and a fold do not fit a table row at 320 CSS px) and a button per
     step ("tick" and "save" would be two places for one decision). -->
<script lang="ts">
  import {
    Actions,
    Badge,
    Button,
    Checkbox,
    Field,
    Notice,
    PageHeader,
    Section,
    Select,
    StatusSummary,
  } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import type { LaunchCheck, LaunchStepView } from '@mycel/core';
  import { fill, isUiKey, plural, ui, refusalCopy } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const list = $derived(data.checklist);

  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form && form.done ? form : null);

  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now: new Date(list.checkedAt),
      relative: data.dateFormat !== 'absolute',
    });

  /** Where a check's finding is fixed. */
  const FIX: Record<LaunchCheck, string> = {
    'home-published': 'content?type=page',
    'team-ready': 'leden',
    'form-notifications': 'forms',
    'payments-connected': 'connections',
    analytics: 'site#site-analytics',
    'custom-domain': 'domeinen',
    'ops-healthy': 'status',
  };
  const fix = (step: LaunchStepView) => (step.check ? `${base}/${FIX[step.check]}` : null);

  /** A step's words from the catalog; a step the catalog does not know yet shows its id. */
  const words = (id: string, part: 'title' | 'description') => {
    const key = `admin.launch.step.${id}.${part}`;
    return isUiKey(key) ? t(key) : part === 'title' ? id : '';
  };
  const title = (id: string) => words(id, 'title');
  const description = (id: string) => words(id, 'description');
  /** What a check found, in words; an unknown code shows as it is rather than as nothing. */
  const finding = (step: LaunchStepView) => {
    if (!step.detail) return null;
    const key = `admin.launch.check.${step.detail.code}`;
    return isUiKey(key) ? fill(t(key), step.detail.params ?? {}) : step.detail.code;
  };
  const needsAttention = (s: LaunchStepView) =>
    s.applicable && (s.status === 'fail' || (s.status === 'warn' && !s.acknowledged));

  const attention = $derived(
    list.phases
      .flatMap((p) => p.steps)
      .filter(needsAttention)
      .map((s) => ({
        label: title(s.id),
        action: finding(s) ?? '',
        href: fix(s) ?? `#step-${s.id}`,
      }))
  );
  const verdict = $derived(
    list.ready
      ? t('admin.launch.verdict.ready')
      : plural(t, 'admin.launch.verdict', list.blocking.length)
  );

  const STATUS_TONE = {
    done: 'success',
    pass: 'success',
    warn: 'warning',
    fail: 'error',
    open: 'neutral',
    na: 'neutral',
  } as const;
  const badge = (s: LaunchStepView) =>
    s.status === 'warn' && s.acknowledged
      ? { tone: 'success' as const, text: t('admin.launch.status.accepted') }
      : { tone: STATUS_TONE[s.status], text: t(`admin.launch.status.${s.status}`) };
  /** The tick a row shows: "done" on a manual step, "accept" on a warning; nothing otherwise. */
  const toggle = (s: LaunchStepView) =>
    !s.applicable ? null : s.kind === 'manual' ? 'done' : s.status === 'warn' ? 'ack' : null;

  const ownerOptions = $derived([
    { value: '', label: t('admin.launch.owner.default') },
    { value: 'platform', label: t('admin.launch.owner.platform') },
    { value: 'organisation', label: t('admin.launch.owner.organisation') },
    { value: 'shared', label: t('admin.launch.owner.shared') },
  ]);
  const applicableOptions = $derived([
    { value: '', label: t('admin.launch.applicable.default') },
    { value: 'on', label: t('admin.launch.applicable.on') },
    { value: 'off', label: t('admin.launch.applicable.off') },
  ]);
</script>

<svelte:head>
  <title
    >{failed ? `${t('error.prefix')} ` : ''}{t('admin.launch.title')} · {data.tenant.name}</title
  >
</svelte:head>

<main class="page admin">
  <PageHeader
    title={t('admin.launch.title')}
    locale={data.locale}
    breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.launch.title') }]}
  />

  {#if failed}
    <Notice tone="error" title={t('error.summary.title')}><p>{refusalCopy(t, failed)}</p></Notice>
  {/if}
  {#if done}
    <Notice tone="success"
      ><p>
        {done.done === 'admin.launch.done.unchanged'
          ? t(done.done)
          : plural(t, 'admin.launch.done.saved', done.n)}
      </p></Notice
    >
  {/if}

  {#if done && done.moved}
    <Notice tone="warning"><p>{plural(t, 'admin.launch.moved', done.moved)}</p></Notice>
  {/if}

  <p>{t('admin.launch.intro')}</p>

  <StatusSummary
    id="verdict"
    title={verdict}
    tone={list.ready ? 'ok' : 'attention'}
    checked={when(list.checkedAt)}
    checkedLabel={t('admin.launch.checked')}
    items={attention}
  />

  {#each list.phases as phase (phase.phase)}
    {@const shown = phase.steps.filter((s) => s.applicable)}
    {@const off = phase.steps.filter((s) => !s.applicable)}
    {@const name = t(`admin.launch.phase.${phase.phase}`)}
    <Section
      id="phase-{phase.phase}"
      title={name}
      intro={t(`admin.launch.phase.${phase.phase}.intro`)}
      count={fill(t('admin.launch.progress'), { complete: phase.complete, total: phase.total })}
      locale={data.locale}
    >
      <form method="post" action="?/save">
        {#if shown.length}
          <ul class="ui-rows">
            {#each shown as step (step.id)}{@render row(step)}{/each}
          </ul>
        {/if}
        {#if off.length}
          <details class="ui-fold">
            <summary>{plural(t, 'admin.launch.off', off.length)}</summary>
            <ul class="ui-rows">
              {#each off as step (step.id)}{@render row(step)}{/each}
            </ul>
          </details>
        {/if}
        <Actions>
          <Button aria-label="{t('admin.launch.save')}: {name}">{t('admin.launch.save')}</Button>
        </Actions>
      </form>
    </Section>
  {/each}
</main>

{#snippet row(step: LaunchStepView)}
  {@const b = badge(step)}
  {@const found = finding(step)}
  {@const tick = toggle(step)}
  {@const href = fix(step)}
  <li class="ui-row block" id="step-{step.id}" data-step={step.id}>
    <h3 id="step-{step.id}-title">{title(step.id)}</h3>
    <ul class="ui-badges">
      <li><Badge tone={b.tone}>{b.text}</Badge></li>
      <li><Badge>{t(`admin.launch.owner.${step.owner}`)}</Badge></li>
    </ul>
    <p>{description(step.id)}</p>
    {#if found && step.applicable}
      <p class="ui-row-state">
        {found}
        {#if href && step.status !== 'pass'}<a {href}>{t(`admin.launch.fix.${step.check!}`)}</a
          >{/if}
      </p>
      {#if step.detail?.subjects?.length}
        <!-- In a sentence, not a list: links in running text are spaced by the text itself, where
             a list of short names would put the targets on top of each other (axe target-size). -->
        <p>
          {t('admin.launch.forms')}
          {#each step.detail.subjects as subject, i (subject.id)}{#if i}{', '}{/if}<a
              href="{base}/forms/{subject.id}">{subject.label ?? t('admin.launch.form.untitled')}</a
            >{/each}
        </p>
      {/if}
    {/if}
    <div class="ui-fields" role="group" aria-labelledby="step-{step.id}-title">
      <input type="hidden" name="step" value={step.id} />
      <input type="hidden" name="seen-{step.id}" value={step.updatedAt ?? ''} />
      {#if tick}
        <input type="hidden" name="toggle-{step.id}" value={tick} />
        <Checkbox
          id="tick-{step.id}"
          name="tick-{step.id}"
          label={t(tick === 'done' ? 'admin.launch.tick.done' : 'admin.launch.tick.accept')}
          checked={tick === 'done' ? step.done : step.acknowledged}
        />
      {/if}
      {#if step.note}
        <p class="ui-row-state">{t('admin.launch.note')}: {step.note}</p>
      {/if}
      <details class="ui-fold">
        <summary>{t(step.note ? 'admin.launch.adjust' : 'admin.launch.adjust.note')}</summary>
        <div class="ui-fields">
          <Field id="note-{step.id}" label={t('admin.launch.note')} locale={data.locale}>
            {#snippet control(attributes)}<textarea
                {...attributes}
                name="note-{step.id}"
                rows="2"
                maxlength="1000">{step.note}</textarea
              >{/snippet}
          </Field>
          <Select
            id="owner-{step.id}"
            name="owner-{step.id}"
            label={t('admin.launch.owner')}
            locale={data.locale}
            options={ownerOptions}
            value={step.ownerOverridden ? step.owner : ''}
          />
          <Select
            id="applicable-{step.id}"
            name="applicable-{step.id}"
            label={t('admin.launch.applicable')}
            locale={data.locale}
            options={applicableOptions}
            value={step.applicableSource === 'override' ? (step.applicable ? 'on' : 'off') : ''}
            hint={step.applicableSource === 'entitlement'
              ? t('admin.launch.applicable.entitlement')
              : undefined}
          />
        </div>
      </details>
    </div>
  </li>
{/snippet}
