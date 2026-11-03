<!-- Keep publication controls inside the edit form. Native disclosure is the no-script
     fallback; the modal enhances those same fields without moving or cloning them. Rejected:
     a detached modal form, which loses the editor fields when publication saves first. -->
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { ui } from '../../../../i18n/index.js';
  let {
    id,
    title,
    locale,
    refused = false,
    children,
  }: {
    id: string;
    title: string;
    locale: string;
    refused?: boolean;
    children: Snippet;
  } = $props();
  const t = $derived(ui(locale));
  let dialog: HTMLDialogElement;
  let disclosure: HTMLDetailsElement;
  let enhanced = $state(false);
  let opener: HTMLElement | null = null;
  onMount(() => {
    dialog.close();
    disclosure.open = true;
    enhanced = true;
    const open = (event: MouseEvent) => {
      const trigger =
        event.target instanceof Element ? event.target.closest(`a[href="#${id}"]`) : null;
      if (!trigger) return;
      event.preventDefault();
      opener = trigger as HTMLElement;
      dialog.showModal();
    };
    const followIssue = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
      if (!link) return;
      const target = document.getElementById(link.getAttribute('href')!.slice(1));
      if (target && !dialog.contains(target)) {
        opener = null;
        dialog.close();
        target.focus({ preventScroll: true });
      }
    };
    dialog.addEventListener('click', followIssue);
    document.addEventListener('click', open);
    const restoreFocus = () => opener?.focus({ preventScroll: true });
    dialog.addEventListener('close', restoreFocus);
    if (refused) dialog.showModal();
    return () => {
      document.removeEventListener('click', open);
      dialog.removeEventListener('close', restoreFocus);
      dialog.removeEventListener('click', followIssue);
    };
  });
</script>

<details bind:this={disclosure} open class="ui-publication-disclosure" class:enhanced>
  <summary>{title}</summary>
  <dialog
    bind:this={dialog}
    {id}
    open
    class="ui-dialog ui-publication-drawer"
    aria-labelledby="{id}-heading"
    closedby="any"
  >
    <div class="ui-dialog-head">
      <h2 id="{id}-heading">{title}</h2>
      {#if enhanced}<button type="button" class="ui-button secondary" onclick={() => dialog.close()}
          >{t('admin.ui.close')}</button
        >{/if}
    </div>
    <div class="ui-dialog-body">{@render children()}</div>
  </dialog>
</details>
