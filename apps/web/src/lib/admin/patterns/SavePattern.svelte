<!-- "Save as pattern" under the block list (ADR 013 rule 4 as refined 2026-11-16): a
     name and the run of blocks from one to another, saved by a button of the one document form
     after what was typed, without JavaScript too. The saved pattern is offered at every insertion
     point and when a new item starts; its blocks keep their names, which are its named slots.
     Server side: `lib/server/patterns/editor.ts`. Rejected: a checkbox per block card, which
     cannot say where a run starts and would add a control to every card. -->
<script lang="ts">
  import { Actions, Button, Field, Icon } from '#lib/admin/ui/index.js';
  import type { BlockType } from '@mycel/core';
  import { fill, ui } from '../../../i18n/index.js';

  let {
    blocks,
    locale,
    action,
    failed,
  }: {
    blocks: readonly { id: string; type: BlockType; naming: { name: string } }[];
    locale: string;
    /** The screen's action address by name. */
    action: (name: string) => string;
    /** The error key of the screen's last refusal; the missing name shows here, fold open. */
    failed?: string | undefined;
  } = $props();
  const t = $derived(ui(locale));
  const error = $derived(
    failed === 'admin.pattern.save.nameRequired' ? t('admin.pattern.save.nameRequired') : undefined
  );
  const label = (b: (typeof blocks)[number], i: number) =>
    fill(t('admin.pattern.save.block'), {
      n: String(i + 1),
      block: b.naming.name || t(`admin.block.type.${b.type}` as const),
    });
</script>

{#if blocks.length}
  <details class="ui-block-insert" id="save-pattern" open={!!error}>
    <summary><Icon name="layers" />{t('admin.pattern.save.fold')}</summary>
    <div class="ui-block-insert-body">
      <p class="ui-hint">{t('admin.pattern.save.hint')}</p>
      <Field
        id="pattern-name"
        name="patternName"
        label={t('admin.pattern.save.name')}
        {locale}
        {error}
        maxlength={200}
        autocomplete="off"
      />
      {#each [['patternFrom', 0], ['patternTo', blocks.length - 1]] as const as [name, chosen] (name)}
        <Field id="pattern-{name}" label={t(`admin.pattern.save.${name}` as const)} {locale}>
          {#snippet control(attributes)}
            <select {name} {...attributes}>
              {#each blocks as b, i (b.id)}
                <option value={b.id} selected={i === chosen}>{label(b, i)}</option>
              {/each}
            </select>
          {/snippet}
        </Field>
      {/each}
      <Actions>
        <Button variant="secondary" formaction={action('savePattern')}
          >{t('admin.pattern.save.submit')}</Button
        >
      </Actions>
    </div>
  </details>
{/if}
