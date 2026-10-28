<!-- One section of a settings page: a heading, its own form and its own save, with the
     confirmation in the section that was saved (brief #56 § B: save per section with
     confirmation). A failure is the screen's to show next to the field it concerns. A section
     that uploads takes `enctype`; one with more than a save (replace and remove) brings its own
     `actions`, still inside the one form. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Actions from './Actions.svelte';
  import Button from './Button.svelte';
  import Notice from './Notice.svelte';

  let {
    id,
    title,
    description,
    action,
    enctype,
    submit,
    saved,
    actions,
    children,
  }: {
    id: string;
    title: string;
    description?: string | undefined;
    /** The form action, `?/name`. */
    action: string;
    enctype?: 'multipart/form-data' | undefined;
    /** The save button's label; ignored when `actions` is given. */
    submit: string;
    /** The section's own buttons instead of the one save, usually an Actions group. */
    actions?: Snippet;
    /** The confirmation after a save of this section. */
    saved?: string | undefined;
    children: Snippet;
  } = $props();
</script>

<section class="ui-settings-section" aria-labelledby="{id}-title">
  <h2 id="{id}-title">{title}</h2>
  {#if description}<p class="ui-hint">{description}</p>{/if}
  {#if saved}<Notice tone="success"><p>{saved}</p></Notice>{/if}
  <form method="post" {action} {enctype}>
    <div class="ui-fields">{@render children()}</div>
    {#if actions}{@render actions()}{:else}<Actions><Button>{submit}</Button></Actions>{/if}
  </form>
</section>
