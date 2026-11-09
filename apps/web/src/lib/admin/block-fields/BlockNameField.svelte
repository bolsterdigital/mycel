<!-- Editorial metadata stays in the block head even while its content is collapsed. The
     document form owns saving; a separate rename action would discard other typed fields. -->
<script lang="ts">
  import type { UiKey } from '../../../i18n/index.js';
  import type { blockNaming } from '../../server/content/block-names.js';
  let {
    block,
    values,
    work,
    t,
    editable,
  }: {
    block: { id: string; naming: ReturnType<typeof blockNaming> };
    values: Record<string, string | string[]>;
    work: string;
    t: (key: UiKey) => string;
    editable: boolean;
  } = $props();
</script>

{#if editable}
  <div class="ui-block-name-field" data-block-naming={JSON.stringify(block.naming)}>
    <label for="name-{block.id}">{t('admin.block.name')}</label>
    <input
      id="name-{block.id}"
      name="b.{block.id}.name.{work}"
      type="text"
      maxlength="120"
      lang={work}
      aria-describedby="name-{block.id}-help"
      value={values[`b.${block.id}.name.${work}`] ?? block.naming.names[work] ?? ''}
      placeholder={block.naming.automatic}
      data-editorial-name
    />
    <small class="ui-hint" id="name-{block.id}-help">{t('admin.block.nameHelp')}</small>
  </div>
{/if}

<style>
  .ui-block-name-field {
    flex: 1 1 16rem;
    min-inline-size: 0;
    max-inline-size: 40ch;
    display: grid;
    gap: var(--space-1);
  }
  input {
    inline-size: 100%;
    min-block-size: var(--tap);
    min-inline-size: 0;
  }
</style>
