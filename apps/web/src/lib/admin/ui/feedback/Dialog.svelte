<!-- A modal dialog that needs no script: the trigger and the close button are native invoker
     buttons (`commandfor`/`command`), the browser traps focus, closes on Escape and returns focus
     to the trigger; `closedby="any"` also closes it on a click outside. `wide` is the lightbox
     size. Rejected: a `:target` overlay (no focus trap, the URL changes) and a script that
     calls showModal() (the admin ships no client JavaScript). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ui } from '../../../../i18n/index.js';

  let {
    id,
    title,
    trigger,
    locale,
    variant = 'secondary',
    wide = false,
    children,
  }: {
    id: string;
    title: string;
    /** The label of the button that opens the dialog. */
    trigger: string;
    locale: string;
    variant?: 'primary' | 'secondary' | 'link';
    wide?: boolean;
    children: Snippet;
  } = $props();

  const t = $derived(ui(locale));
</script>

<button class="ui-button {variant}" type="button" commandfor={id} command="show-modal"
  >{trigger}</button
>
<dialog class={['ui-dialog', wide && 'wide']} {id} aria-labelledby="{id}-title" closedby="any">
  <div class="ui-dialog-head">
    <h2 id="{id}-title">{title}</h2>
    <button class="ui-button secondary" type="button" commandfor={id} command="close"
      >{t('admin.ui.close')}</button
    >
  </div>
  <div class="ui-dialog-body">{@render children()}</div>
</dialog>
