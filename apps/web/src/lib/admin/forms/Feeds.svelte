<!-- A missing connection remains a visible, disabled configuration; core owns consent checks. -->
<script lang="ts">
  import { Actions, Button, Checkbox, Field } from '../ui/index.js';
  import { ui } from '../../../i18n/index.js';
  import type { FormDefinition, FormFeedState, ConnectionRecord } from '@mycel/core';
  import Condition from './Condition.svelte';
  let {
    form,
    state,
    connections,
    availability,
    locale,
    editable,
  }: {
    form: FormDefinition;
    state: FormFeedState;
    connections: Pick<ConnectionRecord, 'id' | 'purpose' | 'version'>[];
    availability: { id: string; failure: string | null }[];
    locale: string;
    editable: boolean;
  } = $props();
  const t = $derived(ui(locale));
</script>

<section>
  <h2>{t('admin.forms.feeds')}</h2>
  {#each [...state.value.feeds.filter((f) => f.formId === form.id), undefined] as feed, index}
    {@const id = `feed-${index}`}
    <details>
      <summary>{feed?.id ?? t('admin.forms.newFeed')}</summary>
      {#if feed}<p>
          {t('admin.forms.availability')}: {availability.find((a) => a.id === feed.id)?.failure ??
            t('admin.forms.enabled')}
        </p>{/if}
      <form method="post" action="?/feed" class="ui-fields">
        <input type="hidden" name="version" value={state.version} />
        <Field
          id="{id}-id"
          name="id"
          label={t('admin.forms.id')}
          {locale}
          value={feed?.id ?? ''}
          readonly={!!feed}
          required
        />
        <Checkbox
          id="{id}-enabled"
          name="enabled"
          label={t('admin.forms.enabled')}
          checked={feed?.enabled}
        />
        <Field id="{id}-connection" label={t('admin.forms.connection')} {locale}
          >{#snippet control(a)}<select {...a} name="connectionId"
              ><option value="">{t('admin.forms.unconnected')}</option
              >{#each connections as c}<option value={c.id} selected={c.id === feed?.connectionId}
                  >{c.purpose} ({c.version})</option
                >{/each}</select
            >{/snippet}</Field
        >
        <Field
          id="{id}-version"
          name="connectionVersion"
          type="number"
          min="1"
          label={t('admin.forms.connectionVersion')}
          {locale}
          value={feed?.connectionVersion ?? ''}
        />
        <Field
          id="{id}-scope"
          name="scope"
          label={t('admin.forms.scope')}
          {locale}
          value={feed?.scope ?? form.list}
          required
        />
        <Field id="{id}-mapping" label={t('admin.forms.mapping')} {locale}
          >{#snippet control(a)}<textarea {...a} name="mapping" rows="4"
              >{feed?.mapping.map((m) => `${m.fieldId}=${m.target}`).join('\n') ??
                'email=email'}</textarea
            >{/snippet}</Field
        >
        <Condition
          scope={id}
          prefix="when"
          label={t('admin.forms.condition')}
          {locale}
          fields={form.fields}
          value={feed?.when}
        />
        <Actions
          ><Button name="command" value="feed" disabled={!editable}>{t('admin.forms.save')}</Button
          >{#if feed}<Button name="command" value="removeFeed" disabled={!editable} formnovalidate
              >{t('admin.forms.remove')}</Button
            >{/if}</Actions
        >
      </form>
    </details>
  {/each}
</section>
