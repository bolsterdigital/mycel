<!-- A refused save on an older revision (ADR 026): who saved in between and when, then the values
     both saves changed, one question each: the field, then "keep mine" (checked: the form already
     shows it) or "use theirs", each option with the words of that version. Everything else of the
     other save is already in the form, so nothing else asks. Without choices (a pattern on a
     filled document, input put back after a login) it shows the difference table instead.
     Native radios with `form`, because the notice stands above the edit form, so the choice is
     posted with any button of that form and works without JavaScript. Styled as the admin's
     Choices groups; not that component, which cannot name another form. Rejected: a table with a
     radio per cell (two columns of long text do not fit 320 px, and a cell is not a label). -->
<script lang="ts">
  import type { BlockType } from '@mycel/core';
  import { fill, ui, type UiKey } from '../../../i18n/index.js';
  import Diff from '../Diff.svelte';
  import { Notice } from '../ui/index.js';

  let {
    conflict,
    form,
    locale,
  }: {
    conflict: {
      who: string;
      when: string;
      changes: { path: string; before: string; after: string }[];
      choices: Choice[];
    };
    /** The id of the form the choices are posted with. */
    form: string;
    locale: string;
  } = $props();

  type Choice = {
    path: string;
    label: UiKey;
    blockType?: BlockType;
    params: Record<string, string>;
    theirs: string | null;
    mine: string | null;
    keep: string | null;
  };
  const choices = $derived(conflict.choices);

  const t = $derived(ui(locale));
  const legendOf = (c: Choice) => {
    const type = c.blockType ? t(`admin.block.type.${c.blockType}` as const) : '';
    const label = fill(t(c.label), { ...c.params, type });
    return c.params['locale'] ? `${label} (${c.params['locale']})` : label;
  };
  const words = (v: string | null) => (v === null ? t('admin.content.conflict.removed') : v);
</script>

<Notice tone="error" title={t('admin.content.conflict.title')}>
  <p>
    {fill(t(`admin.content.conflict.${choices.length ? 'body' : 'bodyTable'}`), {
      who: conflict.who,
      when: conflict.when,
    })}
  </p>
  {#if choices.length}
    <div class="conflict-choices" role="group" aria-labelledby="conflict-choices-title">
      <p class="conflict-title" id="conflict-choices-title">
        {t('admin.content.conflict.choices')}
      </p>
      {#each choices as c, i (c.path)}
        <fieldset class="ui-fieldset ui-choices">
          <legend>{legendOf(c)}</legend>
          {#each ['mine', 'theirs'] as const as side (side)}
            <div class="ui-choice">
              <input
                type="radio"
                id="conflict-{i}-{side}"
                name="resolve.{c.path}"
                value={side}
                {form}
                checked={side === 'mine'}
              />
              <label for="conflict-{i}-{side}">
                <span class="conflict-side">{t(`admin.content.conflict.${side}`)}</span>
                <span class="conflict-words">{words(side === 'mine' ? c.mine : c.theirs)}</span>
              </label>
            </div>
          {/each}
          {#if c.keep}<input type="hidden" name="keep.{c.path}" value={c.keep} {form} />{/if}
        </fieldset>
      {/each}
    </div>
  {:else}
    <Diff rows={conflict.changes} {locale} />
  {/if}
</Notice>

<style>
  .conflict-choices {
    display: grid;
    gap: var(--space-2);
    margin-block-start: var(--space-2);
  }
  .conflict-title {
    margin: 0;
    font-weight: 600;
  }
  .conflict-side {
    font-weight: 600;
  }
  .conflict-side::after {
    content: ': ';
  }
  .conflict-words {
    overflow-wrap: anywhere;
  }
</style>
