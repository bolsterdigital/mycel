<!-- One section of a settings page: a heading, its own form and its own save, with the
     confirmation in the section that was saved (brief #56 § B: save per section with
     confirmation). A failure is the screen's to show next to the field it concerns. -->
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
    submit,
    saved,
    children,
  }: {
    id: string;
    title: string;
    description?: string | undefined;
    /** The form action, `?/name`. */
    action: string;
    submit: string;
    /** The confirmation after a save of this section. */
    saved?: string | undefined;
    children: Snippet;
  } = $props();
</script>

<section class="ui-settings-section" aria-labelledby="{id}-title">
  <h2 id="{id}-title">{title}</h2>
  {#if description}<p class="ui-hint">{description}</p>{/if}
  {#if saved}<Notice tone="success"><p>{saved}</p></Notice>{/if}
  <form method="post" {action}>
    <div class="ui-fields">{@render children()}</div>
    <Actions><Button>{submit}</Button></Actions>
  </form>
</section>
