<!-- Bounded typed predicates use native selects and inputs, including without JavaScript. -->
<script lang="ts">
  import { Field, Fieldset } from '../ui/index.js';
  import { ui } from '../../../i18n/index.js';
  import type { FieldPredicate, FormField } from '@mycel/core';
  let {
    prefix,
    label,
    locale,
    fields,
    value,
    scope = 'condition',
  }: {
    scope?: string;
    prefix: string;
    label: string;
    locale: string;
    fields: FormField[];
    value?: FieldPredicate;
  } = $props();
  const t = $derived(ui(locale));
  const atoms = $derived(value ? ('conditions' in value ? value.conditions : [value]) : []);
</script>

<Fieldset legend={label}>
  <Field
    id="{scope}-{prefix}-mode"
    name="{prefix}.mode"
    label={t('admin.forms.condition')}
    {locale}
  >
    {#snippet control(attrs)}<select {...attrs} name="{prefix}.mode">
        {#each ['', 'atom', 'and', 'or'] as mode}<option
            value={mode}
            selected={mode === (value ? ('conditions' in value ? value.op : 'atom') : '')}
            >{t(`admin.forms.${mode || 'none'}` as 'admin.forms.none')}</option
          >{/each}
      </select>{/snippet}</Field
  >
  <details>
    <summary>{t('admin.forms.condition')}</summary>
    {#each Array.from({ length: 8 }, (_, i) => i) as i}
      {@const atom = atoms[i]}
      <Fieldset legend={`${t('admin.forms.condition')} ${i + 1}`}>
        <Field id="{scope}-{prefix}-{i}-field" label={t('admin.forms.field')} {locale}>
          {#snippet control(attrs)}<select {...attrs} name="{prefix}.{i}.field"
              ><option value=""></option>{#each fields as f}<option
                  value={f.id ?? f.name}
                  selected={(f.id ?? f.name) === atom?.fieldId}>{f.name}</option
                >{/each}</select
            >{/snippet}
        </Field>
        <Field id="{scope}-{prefix}-{i}-op" label={t('admin.forms.operator')} {locale}>
          {#snippet control(attrs)}<select {...attrs} name="{prefix}.{i}.op"
              >{#each ['equals', 'not-equals', 'present'] as op}<option
                  value={op}
                  selected={op === atom?.op}
                  >{t(`admin.forms.${op}` as 'admin.forms.equals')}</option
                >{/each}</select
            >{/snippet}</Field
        >
        <Field id="{scope}-{prefix}-{i}-type" label={t('admin.forms.valueType')} {locale}>
          {#snippet control(attrs)}<select {...attrs} name="{prefix}.{i}.type"
              >{#each ['string', 'boolean', 'number'] as type}<option
                  value={type}
                  selected={atom && 'value' in atom
                    ? typeof atom.value === type
                    : type === 'string'}>{t(`admin.forms.${type}` as 'admin.forms.string')}</option
                >{/each}</select
            >{/snippet}</Field
        >
        <Field
          id="{scope}-{prefix}-{i}-value"
          name="{prefix}.{i}.value"
          label={t('admin.forms.value')}
          {locale}
          value={atom && 'value' in atom ? String(atom.value) : ''}
        />
      </Fieldset>
    {/each}
  </details>
</Fieldset>
