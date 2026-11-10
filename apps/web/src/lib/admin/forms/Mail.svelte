<!-- Mail authoring retains the versioned private settings boundary; visitors never choose recipients. -->
<script lang="ts">
  import { Actions, Button, Checkbox, Field } from '../ui/index.js';
  import { ui } from '../../../i18n/index.js';
  import type { FormDefinition, FormMailState, FormMailAction } from '@mycel/core';
  import Condition from './Condition.svelte';
  import CopyFields from './CopyFields.svelte';
  let {
    form,
    state,
    locale,
    editable,
  }: { form: FormDefinition; state: FormMailState; locale: string; editable: boolean } = $props();
  const t = $derived(ui(locale));
  const config = $derived(state.value.forms.find((f) => f.formId === form.id));
</script>

<section>
  <h2>{t('admin.forms.mail')}</h2>
  <h3>{t('admin.forms.templates')}</h3>
  {#each [...state.value.templates, undefined] as template, index}
    <details>
      <summary>{template?.id ?? t('admin.forms.newTemplate')}</summary>
      <form method="post" action="?/mail" class="ui-fields">
        <input type="hidden" name="version" value={state.version} />
        <Field
          id="template-{index}-id"
          name="id"
          label={t('admin.forms.id')}
          {locale}
          value={template?.id ?? ''}
          readonly={!!template}
          required
        />
        <CopyFields
          id="template-{index}-subject"
          prefix="subject"
          label={t('admin.forms.subject')}
          {locale}
          value={template?.subject}
        />
        <CopyFields
          id="template-{index}-text"
          prefix="text"
          label={t('admin.forms.text')}
          {locale}
          value={template?.text}
          multiline
        />
        <Actions
          ><Button name="command" value="template" disabled={!editable}
            >{t('admin.forms.save')}</Button
          >{#if template}<Button
              name="command"
              value="removeTemplate"
              disabled={!editable}
              formnovalidate>{t('admin.forms.remove')}</Button
            >{/if}</Actions
        >
      </form>
    </details>{/each}
  <h3>{t('admin.forms.confirmation')}</h3>
  <form method="post" action="?/mail" class="ui-fields">
    <input type="hidden" name="command" value="mailSettings" /><input
      type="hidden"
      name="version"
      value={state.version}
    />
    <Checkbox
      id="mail-enabled"
      name="enabled"
      label={t('admin.forms.enabled')}
      checked={config?.enabled}
    />
    {@render reference('confirmation', config?.confirmation)}
    <Actions><Button disabled={!editable}>{t('admin.forms.save')}</Button></Actions>
  </form>
  <h3>{t('admin.forms.notifications')}</h3>
  {#each [...(config?.actions ?? []), undefined] as action, index}
    <details>
      <summary>{action?.id ?? t('admin.forms.newAction')}</summary>{@render editAction(
        action,
        index
      )}
    </details>
  {/each}
</section>
{#snippet reference(id: string, ref?: FormMailAction['template'])}
  <Field id="{id}-template" label={t('admin.forms.templateId')} {locale}
    >{#snippet control(a)}<select {...a} name="templateId"
        ><option value=""></option>{#each state.value.templates as template}<option
            value={template.id}
            selected={template.id === ref?.templateId}>{template.id}</option
          >{/each}</select
      >{/snippet}</Field
  >
  <p>{t('admin.forms.override')}</p>
  <CopyFields
    id="{id}-subject"
    prefix="subject"
    label={t('admin.forms.subject')}
    {locale}
    value={ref?.override?.subject}
  />
  <CopyFields
    id="{id}-text"
    prefix="text"
    label={t('admin.forms.text')}
    {locale}
    value={ref?.override?.text}
    multiline
  />
{/snippet}
{#snippet editAction(action: FormMailAction | undefined, index: number)}
  {@const id = `action-${index}`}
  <form method="post" action="?/mail" class="ui-fields">
    <input type="hidden" name="version" value={state.version} />
    <Field
      id="{id}-id"
      name="id"
      label={t('admin.forms.id')}
      {locale}
      value={action?.id ?? ''}
      readonly={!!action}
      required
    />
    <Checkbox
      id="{id}-enabled"
      name="enabled"
      label={t('admin.forms.enabled')}
      checked={action?.enabled}
    />
    <Field id="{id}-kind" label={t('admin.forms.type')} {locale}
      >{#snippet control(a)}<select {...a} name="kind"
          >{#each ['notification', 'receipt'] as kind}<option
              value={kind}
              selected={kind === action?.kind}
              >{t(`admin.forms.${kind}` as 'admin.forms.notification')}</option
            >{/each}</select
        >{/snippet}</Field
    >
    <Field
      id="{id}-recipients"
      name="recipients"
      label={t('admin.forms.recipients')}
      {locale}
      value={action?.recipients.join(', ') ?? ''}
    />
    <Condition
      scope={id}
      prefix="when"
      label={t('admin.forms.condition')}
      {locale}
      fields={form.fields}
      value={action?.when}
    />
    {@render reference(id, action?.template)}
    <Actions
      ><Button name="command" value="action" disabled={!editable}>{t('admin.forms.save')}</Button
      >{#if action}<Button name="command" value="removeAction" formnovalidate disabled={!editable}
          >{t('admin.forms.remove')}</Button
        >{/if}</Actions
    >
  </form>
{/snippet}
