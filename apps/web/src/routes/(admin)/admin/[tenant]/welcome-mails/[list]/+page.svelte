<!-- One list's welcome series. With `mailing:send` a form: the switch and five step rows (an item
     and "after N days"; an empty row is no step), and below it the test to yourself. Without it
     the same steps as a table to read. Turning a series on asks once more, naming the list and
     that only new subscribers get it (+page.server.ts). -->
<script lang="ts">
  import { page } from '$app/state';
  import { MAX_AUTOMATION_STEPS } from '@mycel/core';
  import {
    Actions,
    Button,
    Checkbox,
    Field,
    Fieldset,
    FormPage,
    Notice,
    PageHeader,
    Section,
    Select,
    Table,
  } from '#lib/admin/ui/index.js';
  import { fill, plural, refusalCopy, ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';
  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const s = $derived(data.series);
  const base = $derived(`/admin/${data.tenant.slug}/welcome-mails`);
  const title = $derived(fill(t('admin.welcome.series'), { list: s.label }));
  const value = (key: string, initial = '') => form?.values?.[key] ?? initial;
  const itemName = (id: string) =>
    s.items.find((i) => i.value === id)?.label ?? t('admin.welcome.item.unknown');
  const options = $derived([{ value: '', label: t('admin.welcome.item.none') }, ...s.items]);
  const enabled = $derived(
    form?.values ? form.values['enabled'] === 'on' : !!s.automation?.enabled
  );
  const tested = $derived(page.url.searchParams.get('tested'));
</script>

<svelte:head><title>{title} · {data.tenant.name}</title></svelte:head>
{#snippet notices()}{#if form?.confirm}<Notice tone="warning"
      >{fill(t('admin.welcome.confirm'), { list: s.label })}</Notice
    >{:else if form && 'error' in form && form.error}<Notice tone="error"
      >{refusalCopy(t, form)}</Notice
    >{:else if page.url.searchParams.has('saved')}<Notice tone="success"
      >{t('admin.welcome.saved')}</Notice
    >{:else if tested}<Notice tone="success"
      >{plural(t, 'admin.welcome.tested', Number(tested))}</Notice
    >{/if}{/snippet}
{#if s.canSend}
  <FormPage
    {title}
    description={t('admin.welcome.detail.intro')}
    locale={data.locale}
    action="?/save"
    submit={t(form?.confirm ? 'admin.welcome.turnOn' : 'admin.welcome.save')}
    cancel={{ href: base, label: t('admin.welcome.title') }}
    {notices}
  >
    {#if form?.confirm}<input type="hidden" name="confirmed" value="1" />{/if}
    <Checkbox
      id="welcome-enabled"
      name="enabled"
      label={t('admin.welcome.enabled')}
      hint={t('admin.welcome.enabled.hint')}
      checked={enabled}
    />
    {#each Array.from({ length: MAX_AUTOMATION_STEPS }, (_, i) => i) as i (i)}
      {@const step = s.automation?.steps[i]}
      <Fieldset
        legend={fill(t('admin.welcome.step'), { n: i + 1 })}
        hint={step ? plural(t, 'admin.welcome.reached', step.reached) : undefined}
      >
        <Select
          id="step-{i}-item"
          name="step-{i}-item"
          label={t('admin.welcome.item')}
          hint={i === 0 ? t('admin.welcome.item.hint') : undefined}
          locale={data.locale}
          {options}
          value={value(`step-${i}-item`, step?.itemId ?? '')}
        />
        <Field
          id="step-{i}-days"
          name="step-{i}-days"
          type="number"
          min={0}
          max={60}
          unit={t('admin.welcome.days.unit')}
          label={t('admin.welcome.days')}
          locale={data.locale}
          value={value(`step-${i}-days`, step ? String(step.delayDays) : '')}
        />
      </Fieldset>
    {/each}
    {#snippet after()}{#if s.automation}
        <Section
          id="welcome-test"
          title={t('admin.welcome.test')}
          intro={t('admin.welcome.test.intro')}
          locale={data.locale}
        >
          <form method="post" action="?/test">
            <Actions stack
              ><Button variant="secondary">{t('admin.welcome.test.send')}</Button></Actions
            >
          </form>
        </Section>
      {/if}{/snippet}
  </FormPage>
{:else}
  <main class="page admin">
    <PageHeader {title} locale={data.locale} description={t('admin.welcome.detail.intro')} />
    {@render notices()}
    {#if s.automation}
      <p>
        {t(s.automation.enabled ? 'admin.welcome.state.on' : 'admin.welcome.state.off')}
      </p>
      <Table
        id="welcome-steps"
        caption={t('admin.welcome.steps')}
        stack
        card
        columns={[
          { key: 'item', label: t('admin.welcome.item') },
          { key: 'days', label: t('admin.welcome.days') },
          { key: 'reached', label: t('admin.welcome.reachedColumn') },
        ]}
      >
        {#snippet rows()}{#each s.automation?.steps ?? [] as step, i (i)}<tr>
              <th scope="row" data-label={t('admin.welcome.item')}>{itemName(step.itemId)}</th>
              <td data-label={t('admin.welcome.days')}>{step.delayDays}</td>
              <td data-label={t('admin.welcome.reachedColumn')}>{step.reached}</td>
            </tr>{/each}{/snippet}
      </Table>
    {:else}
      <p>{t('admin.welcome.state.none')}</p>
    {/if}
  </main>
{/if}
