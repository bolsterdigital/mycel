<!-- The fixed formatting bar of a writing surface: the complete, keyboard-reachable way to every
     formatting command, also before a word is typed or selected. Conventional symbols instead of
     words (B, I, a chain, list glyphs): each button's accessible name is the word, the same word
     shows with its shortcut on hover and on keyboard focus, and its on/off state is exposed
     (WCAG 2.5.3 "symbolic text characters", APG toolbar). A deliberate exception to the rule
     that every action shows its label; that rule keeps holding for document actions.
     The text style is a native select: it names the current style, works on touch and needs no
     popup of ours. The buttons are one tab stop with arrow keys between them.
     Rejected: word buttons (six of them filled 172 px of a 320 px screen and hid the state) and
     a selection bar alone (nothing to start a list or a heading from an empty line). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Icon, type IconName } from '#lib/admin/ui/index.js';
  import { ui } from '../../i18n/index.js';
  import { isMac, shortcut, type Formatting, type TextStyle } from './formatting.svelte.js';

  let {
    formatting,
    locale,
    disabled = false,
    styleAlternative,
  }: {
    formatting: Formatting;
    locale: string;
    disabled?: boolean;
    styleAlternative?: Snippet;
  } = $props();
  const t = $derived(ui(locale));
  const now = $derived(formatting.state);
  let mac = $state(false);
  $effect(() => {
    mac = isMac();
  });

  interface Tool {
    id: string;
    icon: IconName;
    label: string;
    keys: string;
    /** Undefined for a command that is no toggle (undo, redo). */
    pressed?: boolean;
    disabled?: boolean;
    styleAlternative?: Snippet;
    run: (byKeyboard: boolean) => void;
  }
  const groups = $derived<Tool[][]>([
    [
      {
        id: 'bold',
        icon: 'bold',
        label: t('admin.editor.bold'),
        keys: 'B',
        pressed: now.bold,
        run: () => formatting.toggle('bold'),
      },
      {
        id: 'italic',
        icon: 'italic',
        label: t('admin.editor.italic'),
        keys: 'I',
        pressed: now.italic,
        run: () => formatting.toggle('italic'),
      },
      {
        id: 'code',
        icon: 'code',
        label: t('admin.editor.code'),
        keys: 'E',
        pressed: now.code,
        run: () => formatting.toggle('code'),
      },
      {
        id: 'link',
        icon: 'link',
        label: t('admin.editor.link'),
        keys: 'K',
        pressed: now.link,
        disabled: !now.canLink,
        run: () => formatting.openLink(),
      },
    ],
    [
      {
        id: 'bulletList',
        icon: 'list',
        label: t('admin.editor.bulletList'),
        keys: 'Shift+8',
        pressed: now.bulletList,
        run: () => formatting.toggleList('bulletList'),
      },
      {
        id: 'orderedList',
        icon: 'list-ordered',
        label: t('admin.editor.orderedList'),
        keys: 'Shift+7',
        pressed: now.orderedList,
        run: () => formatting.toggleList('orderedList'),
      },
    ],
    [
      {
        id: 'undo',
        icon: 'undo-2',
        label: t('admin.editor.undo'),
        keys: 'Z',
        disabled: !now.canUndo,
        run: (byKeyboard) => formatting.history('undo', byKeyboard),
      },
      {
        id: 'redo',
        icon: 'redo-2',
        label: t('admin.editor.redo'),
        keys: 'Shift+Z',
        disabled: !now.canRedo,
        run: (byKeyboard) => formatting.history('redo', byKeyboard),
      },
    ],
  ]);
  const styles = $derived<{ value: TextStyle; label: string }[]>([
    { value: 0, label: t('admin.editor.style.paragraph') },
    { value: 1, label: t('admin.editor.heading') },
    { value: 2, label: t('admin.editor.style.subheading') },
    { value: 3, label: t('admin.editor.style.minorHeading') },
  ]);

  // One tab stop for the buttons (APG toolbar): the one last used, or the first that is enabled.
  let current = $state('bold');
  const stop = $derived.by(() => {
    const enabled = groups.flat().filter((tool) => !tool.disabled);
    return (enabled.find((tool) => tool.id === current) ?? enabled[0])?.id;
  });

  let bar: HTMLDivElement;
  let tip: HTMLSpanElement;

  function roving(event: KeyboardEvent) {
    if (event.key === 'Escape') return hideTip();
    if (!(event.target instanceof HTMLButtonElement) || !event.target.matches('[data-tool]'))
      return;
    const tools = [...bar.querySelectorAll<HTMLButtonElement>('button[data-tool]:not(:disabled)')];
    const at = tools.indexOf(event.target);
    const to =
      event.key === 'ArrowRight'
        ? (at + 1) % tools.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + tools.length) % tools.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tools.length - 1
              : -1;
    const next = tools[to];
    if (!next) return;
    event.preventDefault();
    current = next.dataset.tool ?? current;
    next.focus();
  }

  // The name and shortcut of the button under the pointer or the keyboard focus. One element,
  // placed by script and kept inside the bar: a tip per button, centred by CSS, ran past the
  // edge of a narrow screen. Hidden from assistive technology, which has the name already.
  function showTip(event: Event) {
    const tool = event.target instanceof Element ? event.target.closest('button') : null;
    if (!tool?.dataset.tip) return hideTip();
    if (event.type === 'focusin' && !tool.matches(':focus-visible')) return;
    tip.textContent = tool.dataset.tip;
    tip.hidden = false;
    const box = bar.getBoundingClientRect();
    const at = tool.getBoundingClientRect();
    const left = at.left + at.width / 2 - tip.offsetWidth / 2 - box.left;
    tip.style.left = `${Math.max(0, Math.min(left, box.width - tip.offsetWidth))}px`;
    tip.style.top = `${at.bottom - box.top + 4}px`;
  }
  function hideTip() {
    tip.hidden = true;
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus (its buttons hold the one tab stop) -->
<div
  bind:this={bar}
  class="format-bar"
  role="toolbar"
  aria-label={t('admin.editor.formatting')}
  onkeydown={roving}
  onpointerover={showTip}
  onpointerout={hideTip}
  onfocusin={showTip}
  onfocusout={hideTip}
>
  <div class="format-style-slot">
    <select
      class="format-style"
      class:replaced={disabled && !!styleAlternative}
      {disabled}
      aria-label={t('admin.editor.style')}
      value={String(now.style)}
      onchange={(event) => formatting.setStyle(Number(event.currentTarget.value) as TextStyle)}
    >
      {#each styles as style (style.value)}
        <option value={String(style.value)} disabled={style.value > now.deepest}
          >{style.label}</option
        >
      {/each}
    </select>
    {#if styleAlternative}{@render styleAlternative()}{/if}
  </div>
  {#each groups as group, index (index)}
    <div class="format-group">
      {#each group as tool (tool.id)}
        {@const keys = shortcut(tool.keys, mac)}
        <button
          type="button"
          class="format-tool"
          data-tool={tool.id}
          data-tip="{tool.label} ({keys.shown})"
          aria-label={tool.label}
          aria-pressed={tool.pressed}
          aria-keyshortcuts={keys.aria}
          disabled={disabled || tool.disabled}
          tabindex={stop === tool.id ? 0 : -1}
          onmousedown={(event) => event.preventDefault()}
          onclick={(event) => {
            current = tool.id;
            hideTip();
            tool.run(event.detail === 0);
          }}
        >
          <Icon name={tool.icon} />
        </button>
      {/each}
    </div>
  {/each}
  <span bind:this={tip} class="format-tip" aria-hidden="true" hidden></span>
</div>

<style>
  .format-bar {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-0) var(--space-1);
  }
  /* A group wraps inside itself too: at 200% text four 44 px buttons are wider than 320 px. */
  .format-group {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-0);
    min-width: 0;
  }
  .format-group + .format-group {
    padding-inline-start: var(--space-1);
    border-inline-start: var(--border-width) solid var(--color-border);
  }
  /* Both real controls size this shared slot; visibility switches without changing the flex
     candidate. Native disclosure never overlays a neighbouring formatting action. */
  .format-style-slot {
    display: grid;
    min-inline-size: 0;
    max-inline-size: 100%;
  }
  .format-style-slot > .format-style,
  .format-style-slot > :global(details) {
    grid-area: 1 / 1;
    align-self: start;
    min-inline-size: 0;
  }
  .format-style.replaced {
    visibility: hidden;
  }
  .format-bar:has(:global(.writing-native[open]:not([hidden]))) .format-style-slot {
    flex-basis: 100%;
  }
  .format-bar:has(:global(.writing-native[open]:not([hidden]))) .format-group {
    display: none;
  }
  .format-style {
    min-block-size: var(--tap);
    max-inline-size: 100%;
    margin-inline-end: var(--space-0);
    padding-block: 0;
    font: inherit;
    font-weight: 600;
    color: var(--color-surface-fg);
    background-color: transparent;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius);
    cursor: pointer;
  }
  .format-style:hover {
    background-color: var(--status-neutral-bg);
  }
  .format-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-inline-size: var(--tap);
    min-block-size: var(--tap);
    padding: 0;
    color: var(--color-surface-fg);
    background: transparent;
    /* Transparent until forced colours paint it: there a button's shape is its border. */
    border: var(--border-width) solid transparent;
    border-radius: var(--radius);
    cursor: pointer;
  }
  .format-tool:hover:not(:disabled) {
    background: var(--status-neutral-bg);
  }
  /* On is a filled button with a ring: a shape, not a colour alone. */
  .format-tool[aria-pressed='true'] {
    color: var(--color-selected-fg);
    background: var(--color-selected-bg);
    border-color: currentColor;
  }
  .format-tool:disabled {
    color: var(--color-border-strong);
    cursor: default;
  }
  .format-tool:focus-visible,
  .format-style:focus-visible {
    outline: 3px solid var(--color-focus);
    outline-offset: -3px;
  }
  .format-tip {
    position: absolute;
    z-index: 1;
    padding: var(--space-0) var(--space-1);
    font-size: var(--step--1);
    line-height: 1.4;
    white-space: nowrap;
    color: var(--color-body-bg);
    background: var(--color-body-fg);
    border-radius: var(--radius-sm);
    pointer-events: none;
  }
  .format-tip[hidden] {
    display: none;
  }
  @media (forced-colors: active) {
    .format-tool[aria-pressed='true'] {
      color: HighlightText;
      background: Highlight;
    }
    .format-tip {
      border: var(--border-width) solid CanvasText;
    }
  }
</style>
