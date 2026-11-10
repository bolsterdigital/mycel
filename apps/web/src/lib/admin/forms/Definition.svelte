<!-- Native per-field saves retain stable ids and all untouched locales. Shared controls own layout. -->
<script lang="ts">
  import { Actions, Button, Checkbox, Field, Fieldset } from '../ui/index.js';
  import { ui, type UiKey } from '../../../i18n/index.js';
  import type { FormDefinition, FormField } from '@mycel/core';
  import Condition from './Condition.svelte';
  import CopyFields from './CopyFields.svelte';
  let {
    form,
    version,
    locale,
    editable,
  }: { form: FormDefinition; version: string; locale: string; editable: boolean } = $props();
  const t = $derived(ui(locale));
</script>

<section>
  <h2>{t('admin.forms.settings')}</h2>
  <form method="post" action="?/definition" class="ui-fields">
    <input type="hidden" name="version" value={version} /><input
      type="hidden"
      name="command"
      value="settings"
    />
    <Field id="kind" label={t('admin.forms.kind')} {locale}
      >{#snippet control(a)}<select {...a} name="kind"
          >{#each ['signup', 'contact', 'petition', 'rsvp'] as kind}<option
              value={kind}
              selected={kind === form.kind}
              >{t(`admin.forms.option.${kind}` as 'admin.forms.option.signup')}</option
            >{/each}</select
        >{/snippet}</Field
    >
    {#each ['list', 'consentTextVersion'] as const as key}<Field
        id={key}
        name={key}
        label={t(`admin.forms.${key}` as const)}
        {locale}
        value={form[key as 'list']}
      />{/each}
    <CopyFields
      prefix="submitLabel"
      id="submitLabel"
      label={t('admin.forms.submitLabel')}
      {locale}
      value={form.submitLabel}
    />
    <CopyFields
      prefix="thankYou"
      id="thankYou"
      label={t('admin.forms.thankYou')}
      {locale}
      value={form.thankYou}
      multiline
    />
    <Actions><Button disabled={!editable}>{t('admin.forms.save')}</Button></Actions>
  </form>
</section>
<section>
  <h2>{t('admin.forms.fields')}</h2>
  {#each form.fields as field, index (field.id ?? field.name)}
    <details><summary>{field.name}</summary>{@render edit(field, index)}</details>
  {/each}
  <details>
    <summary>{t('admin.forms.newField')}</summary>{@render edit(undefined, form.fields.length)}
  </details>
</section>
{#snippet edit(field: FormField | undefined, index: number)}
  {@const key = field?.id ?? field?.name ?? 'new'}
  <form method="post" action="?/definition" class="ui-fields">
    <input type="hidden" name="version" value={version} /><input
      type="hidden"
      name="fieldId"
      value={field ? key : ''}
    />
    <Field
      id="{key}-id"
      name="id"
      label={t('admin.forms.id')}
      {locale}
      value={key === 'new' ? '' : key}
      readonly={!!field}
      required
    />
    <Field
      id="{key}-name"
      name="name"
      label={t('admin.forms.name')}
      {locale}
      value={field?.name ?? ''}
      required
    />
    <Field id="{key}-type" label={t('admin.forms.type')} {locale}
      >{#snippet control(a)}<select {...a} name="type"
          >{#each ['text', 'textarea', 'email', 'phone', 'number', 'amount', 'date', 'choice', 'multiple-choice', 'checkbox', 'consent', 'hidden'] as type}<option
              value={type}
              selected={type === field?.type}
              >{t(`admin.forms.option.${type}` as 'admin.forms.option.text')}</option
            >{/each}</select
        >{/snippet}</Field
    >
    {#each ['min', 'max', 'maxLength'] as limit}
      <Field
        id="{key}-{limit}"
        name={limit}
        type="number"
        label={t(`admin.forms.option.${limit}` as 'admin.forms.option.min')}
        {locale}
        value={field && limit in field
          ? ((field[limit as keyof typeof field] as string) ?? '')
          : ''}
      />
    {/each}
    <CopyFields
      id="{key}-label"
      prefix="label"
      label={t('admin.forms.label')}
      {locale}
      value={field?.label}
    />
    <CopyFields
      id="{key}-help"
      prefix="help"
      label={t('admin.forms.help')}
      {locale}
      value={field?.help}
    />
    <Checkbox
      id="{key}-required"
      name="required"
      label={t('admin.forms.required')}
      checked={field?.required}
    />
    <Field id="{key}-options" name="options" label={t('admin.forms.options')} {locale}
      >{#snippet control(a)}<textarea {...a} name="options"
          >{field && 'options' in field
            ? field.options
                .map((o) => `${o.value}|${o.label.nl ?? ''}|${o.label.en ?? ''}`)
                .join('\n')
            : ''}</textarea
        >{/snippet}</Field
    >
    <Field
      id="{key}-hidden"
      name="hiddenValue"
      label={t('admin.forms.hiddenValue')}
      {locale}
      value={field?.type === 'hidden' ? field.value : ''}
    />
    <Condition
      scope={key}
      prefix="active"
      label={t('admin.forms.active')}
      {locale}
      fields={form.fields.slice(0, index)}
      value={field?.activeWhen}
    />
    <Condition
      scope={key}
      prefix="requiredWhen"
      label={t('admin.forms.requiredWhen')}
      {locale}
      fields={form.fields.slice(0, index)}
      value={field?.requiredWhen}
    />
    <Field id="{key}-policy" label={t('admin.forms.inactivePolicy')} {locale}
      >{#snippet control(a)}<select {...a} name="inactivePolicy"
          ><option value="discard">{t('admin.forms.discard')}</option><option
            value="reject"
            selected={field?.inactivePolicy === 'reject'}>{t('admin.forms.reject')}</option
          ></select
        >{/snippet}</Field
    >
    <Actions>
      <Button name="command" value="field" disabled={!editable}>{t('admin.forms.save')}</Button>
      {#if field}<Button name="command" value="remove" disabled={!editable} formnovalidate
          >{t('admin.forms.remove')}</Button
        >
        {#if index > 0}<Button name="command" value="up" disabled={!editable} formnovalidate
            >{t('admin.forms.up')}</Button
          >{/if}
        {#if index < form.fields.length - 1}<Button
            name="command"
            value="down"
            disabled={!editable}
            formnovalidate>{t('admin.forms.down')}</Button
          >{/if}{/if}
    </Actions>
  </form>
{/snippet}
