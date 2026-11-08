<!-- Who else has this item open, and whether a newer revision exists (ADR 029). The first render
     is the server's and stands without JavaScript; after hydration the screen reports every beat
     and redraws from the answer. Whether this tab has input is the form's own `data-has-unsaved`
     (edit-screen.js), so the two can never disagree. A hidden tab without input stops reporting;
     one with input keeps going, because that is the tab that can still save. A refused beat
     (signed out, access gone, suspended, item gone) stops the polling; a failed one tries again.
     Rejected: a static script (the lines and their words would be built by hand beside the
     component's), and reloading a clean tab by itself (it replaces the page mid-sentence). -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { fill, ui } from '../../../i18n/index.js';
  import { Button, Notice } from '../ui/index.js';

  type Lines = {
    present: { who: string; state: 'viewing' | 'editing'; self: boolean }[];
    newer: { who: string } | null;
  };
  let {
    presence,
    reload,
    locale,
  }: {
    /** What the server rendered, with where to report and the revision on screen. */
    presence: Lines & { beatMs: number; endpoint: string; base: string };
    /** The address that shows the newest revision, in the locale on screen. */
    reload: string;
    locale: string;
  } = $props();

  const t = $derived(ui(locale));
  // svelte-ignore state_referenced_locally
  let lines = $state<Lines>({ present: presence.present, newer: presence.newer });
  let hasInput = $state(false);

  const line = (p: Lines['present'][number]) =>
    p.self
      ? t(p.state === 'editing' ? 'admin.presence.selfEditing' : 'admin.presence.selfViewing')
      : fill(t(p.state === 'editing' ? 'admin.presence.editing' : 'admin.presence.viewing'), {
          who: p.who,
        });

  /** Per tab and through a reload, so a reload does not leave a second tab behind for a minute. */
  function sessionId(): string {
    const key = 'mycel.presence.session';
    try {
      const known = sessionStorage.getItem(key);
      if (known) return known;
      const made = crypto.randomUUID();
      sessionStorage.setItem(key, made);
      return made;
    } catch {
      return crypto.randomUUID();
    }
  }

  onMount(() => {
    const session = sessionId();
    const form = document.forms.namedItem('item-edit');
    const unsaved = () => !!form?.hasAttribute('data-has-unsaved');
    const baseRevision = () => {
      const field = form?.elements.namedItem('baseRevisionId');
      return field instanceof HTMLInputElement && field.value ? field.value : presence.base;
    };
    let stopped = false;

    async function beat() {
      hasInput = unsaved();
      if (stopped || (document.hidden && !hasInput)) return;
      try {
        const res = await fetch(presence.endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: session,
            state: hasInput ? 'editing' : 'viewing',
            baseRevisionId: baseRevision(),
          }),
        });
        if (res.redirected || (res.status >= 400 && res.status < 500)) {
          stopped = true;
          return;
        }
        if (res.ok) lines = (await res.json()) as Lines;
      } catch {
        // Offline for a moment; the next beat tries again.
      }
    }

    void beat();
    const timer = setInterval(() => void beat(), presence.beatMs);
    const onVisible = () => {
      if (!document.hidden) void beat();
    };
    document.addEventListener('visibilitychange', onVisible);
    const observer = new MutationObserver(() => void beat());
    if (form) observer.observe(form, { attributes: true, attributeFilter: ['data-has-unsaved'] });
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      observer.disconnect();
    };
  });
</script>

<div class="edit-presence" role="status" data-presence>
  {#if lines.present.length}
    <ul class="edit-presence-list">
      {#each lines.present as person (person.who + person.self)}
        <li>{line(person)}</li>
      {/each}
    </ul>
  {/if}
  {#if lines.newer}
    <Notice tone="warning" live={false}>
      <p class="edit-presence-newer">
        <span
          >{fill(
            t(hasInput ? 'admin.presence.newerWithInput' : 'admin.presence.newer'),
            lines.newer
          )}</span
        >
        {#if !hasInput}
          <Button variant="secondary" href={reload} data-sveltekit-reload
            >{t('admin.presence.load')}</Button
          >
        {/if}
      </p>
    </Notice>
  {/if}
</div>

<style>
  .edit-presence-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--step--1);
    color: var(--color-muted-fg);
    overflow-wrap: anywhere;
  }
  .edit-presence-newer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-3);
    margin: 0;
  }
  .edit-presence-newer span {
    flex: 1 1 16rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
