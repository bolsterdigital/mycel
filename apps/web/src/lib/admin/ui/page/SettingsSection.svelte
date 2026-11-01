<!-- One section of a settings page: a heading, its own form and its own save, with the
     confirmation in the section that was saved (brief #56 § B: save per section with
     confirmation). A failure is the screen's to show next to the field it concerns. A section
     that uploads takes `enctype`; one with more than a save (replace and remove) brings its own
     `actions`, still inside the one form. A section without `action` only shows facts. Given
     `unsaved`, static/_admin/unsaved.js shows that text once a field changes and warns before
     leaving the page unsaved (brief #81); without the script nothing changes. A long section
     (Theme) takes `sticky`: its save stays at the bottom of the window while the form scrolls
     past (#113), on a window tall enough that a bar does not take the room to read. Rejected: a
     second save at the top (two buttons for one form, and the top one is out of view as soon as
     the fields begin). -->
<script lang="ts">
  import AdminScript from '../../trusted/AdminScript.svelte';
  import type { Snippet } from 'svelte';
  import Actions from '../display/Actions.svelte';
  import Button from '../display/Button.svelte';
  import Notice from '../feedback/Notice.svelte';

  let {
    id,
    title,
    description,
    action,
    enctype,
    submit,
    saved,
    actions,
    unsaved,
    sticky = false,
    children,
  }: {
    id: string;
    title: string;
    description?: string | undefined;
    /** The form action, `?/name`; without it the section has no form. */
    action?: string | undefined;
    enctype?: 'multipart/form-data' | undefined;
    /** The save button's label; ignored when `actions` is given. */
    submit?: string | undefined;
    /** The section's own buttons instead of the one save, usually an Actions group. */
    actions?: Snippet;
    /** The confirmation after a save of this section. */
    saved?: string | undefined;
    /** The note shown, with JavaScript, once a field of the form has changed. */
    unsaved?: string | undefined;
    /** Keep the save in view at the bottom of the window while a long form scrolls. */
    sticky?: boolean;
    children: Snippet;
  } = $props();
</script>

<svelte:head
  >{#if unsaved}<AdminScript src="/_admin/unsaved.js" />{/if}</svelte:head
>

<section class="ui-settings-section" aria-labelledby="{id}-title">
  <h2 id="{id}-title">{title}</h2>
  {#if description}<p class="ui-hint">{description}</p>{/if}
  {#if saved}<Notice tone="success"><p>{saved}</p></Notice>{/if}
  {#if action}
    <form method="post" {action} {enctype} data-unsaved={unsaved ? '' : undefined}>
      <div class="ui-fields">{@render children()}</div>
      <div class={['ui-settings-save', sticky && 'sticky']}>
        {#if unsaved}<p class="ui-hint" hidden data-unsaved-note>{unsaved}</p>{/if}
        {#if actions}{@render actions()}{:else}<Actions><Button>{submit}</Button></Actions>{/if}
      </div>
    </form>
  {:else}
    {@render children()}
  {/if}
</section>
