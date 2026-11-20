<!-- The dossiers an article or page belongs to (MY-260), in the edit screen's side column: the
     site's dossier pages as checkboxes (the shared Choices, searchable once the list is long, as
     the authors), and the box that keeps the dossier box off this item. `dossiersShown` tells the
     save that the form showed them, so a form without them keeps the stored choice
     (content-admin.ts). A chosen id that is no dossier any more (in the trash, or gone) cannot be
     ticked again: it is posted as it is and listed with a remove button, which saves the form
     without it, because core refuses any save that still names one. Up to three is core's rule;
     a fourth box is refused with a message on this field rather than disabled by a script.
     Rejected: the button target's search picker, which posts one item and finds every page and
     article, and a listbox that needs a script to choose at all. -->
<script lang="ts">
  import { Button, Checkbox, Choices, Notice } from '../ui/index.js';
  import { fill, ui } from '../../../i18n/index.js';
  import type { DossierChoices } from '#lib/server/content/dossier-choices.js';

  let {
    locale,
    base,
    choices,
    selected,
    noBox,
    write,
    removeAction,
    invalid = false,
  }: {
    /** The admin's language. */
    locale: string;
    /** The tenant's admin root, for the link to Dossiers. */
    base: string;
    /** Null for an item that cannot belong to a dossier (a dossier or a zone): nothing shows. */
    choices: DossierChoices | null;
    selected: readonly string[];
    noBox: boolean;
    write: boolean;
    /** The save action, which the remove button posts to. */
    removeAction: string;
    invalid?: boolean;
  } = $props();
  const t = $derived(ui(locale));
</script>

{#if choices}
  <div id="dossiers" class="dossier-fields">
    <input type="hidden" name="dossiersShown" value="1" />
    {#each choices.unavailable as d (d.id)}<input
        type="hidden"
        name="dossierIds"
        value={d.id}
      />{/each}
    {#if choices.available.length}
      <Choices
        id="dossier"
        name="dossierIds"
        type="checkbox"
        searchable
        legend={t('admin.content.dossier.title')}
        hint={t('admin.content.dossier.hint')}
        {locale}
        {invalid}
        {selected}
        options={choices.available.map((d) => ({ value: d.id, label: d.label }))}
      />
    {:else}
      <p class="ui-hint">
        {t('admin.content.dossier.none')}
        <a href="{base}/content?type=page&profile=dossier">{t('admin.content.filter.dossier')}</a>.
      </p>
    {/if}
    {#if choices.unavailable.length}
      <Notice tone="warning" live={false}>
        <ul class="dossier-gone">
          {#each choices.unavailable as d (d.id)}
            {@const name = fill(t('admin.content.dossier.unavailable'), { id: d.label })}
            <li>
              <span>{name}</span>
              {#if write}<Button
                  variant="secondary"
                  formaction={removeAction}
                  name="dropDossier"
                  value={d.id}
                  aria-label={fill(t('admin.content.dossier.removeNamed'), { name })}
                  >{t('admin.content.dossier.remove')}</Button
                >{/if}
            </li>
          {/each}
        </ul>
        <p>{t('admin.content.dossier.unavailableHint')}</p>
      </Notice>
    {/if}
    <Checkbox
      id="noDossierBox"
      name="noDossierBox"
      label={t('admin.content.field.noDossierBox')}
      hint={t('admin.content.field.noDossierBoxHint')}
      checked={noBox}
    />
  </div>
{/if}

<style>
  .dossier-fields {
    display: grid;
    gap: var(--space-2);
  }
  .dossier-gone {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: var(--space-2);
  }
  /* The name and its button share a line while both fit, and wrap otherwise (ui-action-layout). */
  .dossier-gone li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-3);
  }
</style>
