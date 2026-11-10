<!-- What appears at the words themselves: a small bar over a selection, and the link field.
     The selection bar is a shortcut for a pointer, never the only way: it repeats four buttons
     of the fixed bar, stays out of the tab order and does not appear on a touch screen, where
     the system's own selection menu stands in the same place. The link field replaces the
     browser's prompt: it opens under the words, which stay marked while focus is in the field,
     says why an address is refused and gives the selection back on Escape.
     Rejected: TipTap's bubble-menu extension, a dependency with a positioning library for one
     box that two `coordsAtPos` calls place. -->
<script lang="ts">
  import { tick } from 'svelte';
  import { Actions, Button, Field, Icon, type IconName } from '#lib/admin/ui/index.js';
  import { ui } from '../../i18n/index.js';
  import type { Formatting, InlineMark } from './formatting.svelte.js';

  let {
    formatting,
    locale,
    frame,
    id,
  }: {
    formatting: Formatting;
    locale: string;
    /** The positioned element both boxes are placed in: the writing surface's wrapper. */
    frame: HTMLElement | undefined;
    /** Unique per writing surface: a page has one link field per text block. */
    id: string;
  } = $props();
  const t = $derived(ui(locale));
  const now = $derived(formatting.state);

  let bubble = $state<HTMLDivElement>();
  let panel = $state<HTMLDivElement>();
  let dragging = $state(false);
  let fine = $state(false);
  let address = $state('');

  const marks: { mark: InlineMark; icon: IconName; label: string }[] = $derived([
    { mark: 'bold', icon: 'bold', label: t('admin.editor.bold') },
    { mark: 'italic', icon: 'italic', label: t('admin.editor.italic') },
    { mark: 'code', icon: 'code', label: t('admin.editor.code') },
  ]);
  const showBubble = $derived(
    fine && !dragging && !formatting.link && now.selected && !!formatting.editor?.isFocused
  );

  $effect(() => {
    const pointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const read = () => (fine = pointer.matches);
    read();
    pointer.addEventListener('change', read);
    // While the pointer drags a selection the bar would sit under it and follow every move.
    const down = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.ProseMirror')) dragging = true;
    };
    const up = () => (dragging = false);
    frame?.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      pointer.removeEventListener('change', read);
      frame?.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  });

  /** Place a box at a range of the text, inside the frame: above it when asked and there is
   *  room under whatever stays at the top of the window, otherwise below. */
  function place(box: HTMLElement, from: number, to: number, above: boolean) {
    const view = formatting.editor?.view;
    if (!view || !frame) return;
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to, -1);
    const outer = frame.getBoundingClientRect();
    const oneLine = Math.abs(start.top - end.top) < 2;
    const centre = oneLine ? (start.left + end.right) / 2 : start.left + box.offsetWidth / 2;
    const left = centre - box.offsetWidth / 2 - outer.left;
    // What covers the top of the window: the document bar, and this surface's bar while it sticks.
    const bar = frame.querySelector('.ui-writing-sheet-toolbar')?.getBoundingClientRect();
    const covered = Math.max(
      parseFloat(getComputedStyle(document.documentElement).scrollPaddingBlockStart) || 0,
      bar?.bottom ?? 0
    );
    const gap = 8;
    const fits = Math.min(start.top, end.top) - box.offsetHeight - gap > covered;
    const top =
      above && fits
        ? Math.min(start.top, end.top) - box.offsetHeight - gap
        : Math.max(start.bottom, end.bottom) + gap;
    box.style.left = `${Math.max(0, Math.min(left, outer.width - box.offsetWidth))}px`;
    box.style.top = `${top - outer.top}px`;
  }

  $effect(() => {
    void formatting.version;
    const selection = formatting.editor?.state.selection;
    if (showBubble && bubble && selection) place(bubble, selection.from, selection.to, true);
  });

  $effect(() => {
    const draft = formatting.link;
    if (!draft || !panel) return;
    address = draft.href;
    place(panel, draft.from, draft.to, false);
    const open = panel;
    // After the address is in the field, so all of it is selected and one key replaces it.
    void tick().then(() => {
      const field = open.querySelector('input');
      field?.focus();
      field?.select();
    });
    // The field is part of the document form only by place: typing an address is no change of
    // the document, and Enter applies the link instead of saving.
    const quiet = (event: Event) => event.stopPropagation();
    open.addEventListener('input', quiet);
    open.addEventListener('change', quiet);
    // A click elsewhere closes the field and leaves the click its own effect.
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !open.contains(event.target)) formatting.closeLink();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      open.removeEventListener('input', quiet);
      open.removeEventListener('change', quiet);
      document.removeEventListener('pointerdown', outside, true);
    };
  });

  // Read from the field itself: its `input` events stop at the panel, so no handler of ours
  // (delegated to the document) hears them.
  const typed = () => panel?.querySelector('input')?.value ?? '';

  function keys(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      formatting.applyLink(typed());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      formatting.cancelLink();
    }
  }
  /** Focus that leaves the field by keyboard closes it; a pointer is handled above. */
  function left(event: FocusEvent) {
    if (event.relatedTarget instanceof Node && !panel?.contains(event.relatedTarget))
      formatting.closeLink();
  }
</script>

{#if showBubble}
  <div
    bind:this={bubble}
    class="selection-bar"
    role="group"
    aria-label={t('admin.editor.selection')}
  >
    {#each marks as { mark, icon, label } (mark)}
      <button
        type="button"
        class="selection-tool"
        tabindex="-1"
        title={label}
        aria-label={label}
        aria-pressed={now[mark]}
        onmousedown={(event) => event.preventDefault()}
        onclick={() => formatting.toggle(mark)}
      >
        <Icon name={icon} />
      </button>
    {/each}
    <button
      type="button"
      class="selection-tool"
      tabindex="-1"
      title={t('admin.editor.link')}
      aria-label={t('admin.editor.link')}
      aria-pressed={now.link}
      onmousedown={(event) => event.preventDefault()}
      onclick={() => formatting.openLink()}
    >
      <Icon name="link" />
    </button>
  </div>
{/if}

{#if formatting.link}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Enter and Escape of the field in it) -->
  <div
    bind:this={panel}
    class="link-panel"
    role="group"
    aria-label={t('admin.editor.link')}
    onkeydown={keys}
    onfocusout={left}
  >
    <Field
      id="link-{id}"
      label={t('admin.editor.linkPrompt')}
      {locale}
      hint={t('admin.editor.linkHint')}
      hintInline
      error={formatting.refusal || undefined}
      inputmode="url"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      placeholder="https://"
      value={address}
    />
    <Actions>
      <Button type="button" onclick={() => formatting.applyLink(typed())}
        >{t('admin.editor.linkApply')}</Button
      >
      {#if formatting.link.existing}
        <Button type="button" variant="secondary" onclick={() => formatting.removeLink()}
          >{t('admin.editor.linkRemove')}</Button
        >
      {/if}
      <Button type="button" variant="link" onclick={() => formatting.cancelLink()}
        >{t('admin.editor.linkCancel')}</Button
      >
    </Actions>
  </div>
{/if}

<style>
  .selection-bar,
  .link-panel {
    position: absolute;
    z-index: 3;
    color: var(--color-surface-fg);
    background: var(--color-surface-bg);
    border: var(--border-width) solid var(--color-border-strong);
    border-radius: var(--radius);
    box-shadow: var(--shadow-2);
  }
  .selection-bar {
    display: flex;
    gap: var(--space-0);
    padding: var(--space-0);
  }
  .selection-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-inline-size: var(--tap);
    min-block-size: var(--tap);
    padding: 0;
    color: inherit;
    background: transparent;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .selection-tool:hover {
    background: var(--status-neutral-bg);
  }
  .selection-tool[aria-pressed='true'] {
    color: var(--color-selected-fg);
    background: var(--color-selected-bg);
    border-color: currentColor;
  }
  .link-panel {
    inline-size: min(24rem, 100%);
    padding: var(--space-1) var(--space-2);
  }
  @media (forced-colors: active) {
    .selection-tool[aria-pressed='true'] {
      color: HighlightText;
      background: Highlight;
    }
  }
</style>
