<!-- The enhanced article writing view lives beside the native block forms. The forms remain a
     complete route when JavaScript is unavailable; this view posts the same block tree through
     content.item.update. Toolbar actions wrap as whole controls at 320 CSS px and 200% text. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { deserialize } from '$app/forms';
  import { Editor, type JSONContent } from '@tiptap/core';
  import MarkdownIt from 'markdown-it';
  import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
  import { articleExtensions } from '#lib/editor/article-extensions.js';
  import Diff from '#lib/admin/Diff.svelte';
  import { MediaPicker } from '#lib/admin/ui/index.js';
  import { ui } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let isSafeHref: typeof import('@mycel/core').isSafeHref = () => false;

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/content/${data.itemId}`);
  let element: HTMLDivElement;
  let editor = $state<Editor | null>(null);
  let saveStatus = $state<'saved' | 'editing' | 'saving' | 'conflict' | 'error'>('saved');
  let reason = $state('');
  let revisionId = $state('');
  let latest = $state<JSONContent | null>(null);
  let latestRevision = $state('');
  let conflictWho = $state('');
  let conflictWhen = $state('');
  let conflictChanges = $state<{ path: string; before: string; after: string }[]>([]);
  let ignored = $state<string[]>([]);
  type Pending = {
    id: string;
    type: 'quote' | 'image';
    text: string;
    source: string;
    name: string;
    mediaId: string;
    alt: string;
    decorative: boolean;
  };
  let pending = $state<Pending[]>([]);
  let insertLink: HTMLAnchorElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let changes = 0;
  const markdown = new MarkdownIt({ html: false, linkify: false });

  function schedule() {
    changes += 1;
    saveStatus = 'editing';
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), 650);
  }

  async function save() {
    if (!editor || saving || saveStatus === 'conflict') return;
    if (pending.length) {
      reason = t('admin.editor.completeCards');
      return;
    }
    if (timer) clearTimeout(timer);
    const at = changes;
    saving = true;
    saveStatus = 'saving';
    const body = new FormData();
    body.set('baseRevisionId', revisionId);
    body.set('locale', data.locale);
    body.set('editor', JSON.stringify(editor.getJSON()));
    try {
      const response = await fetch('?/save', {
        method: 'POST',
        body,
        headers: { accept: 'application/json' },
      });
      const result = deserialize(await response.text());
      if (result.type === 'success' && result.data?.kind === 'saved') {
        revisionId = String(result.data.revisionId);
        saveStatus = at === changes ? 'saved' : 'editing';
      } else if (result.type === 'failure' && result.data?.kind === 'conflict') {
        latest = result.data.editor as JSONContent;
        latestRevision = String(result.data.revisionId);
        conflictWho = String(result.data.who);
        conflictWhen = String(result.data.when);
        conflictChanges = result.data.changes as typeof conflictChanges;
        saveStatus = 'conflict';
      } else {
        reason = String(
          result.type === 'failure'
            ? Array.isArray(result.data?.issues)
              ? result.data.issues.join('; ')
              : result.data?.kind
            : 'network'
        );
        saveStatus = 'error';
      }
    } catch {
      reason = 'network';
      saveStatus = 'error';
    } finally {
      saving = false;
      if (saveStatus === 'editing') schedule();
    }
  }

  function latestText(node: JSONContent | null): string {
    if (!node) return '';
    return node.text ?? (node.content ?? []).map(latestText).filter(Boolean).join(' ');
  }

  function resolveMine() {
    revisionId = latestRevision;
    latest = null;
    saveStatus = 'editing';
    void save();
  }

  function resolveLatest() {
    if (!editor || !latest) return;
    editor.commands.setContent(latest);
    revisionId = latestRevision;
    latest = null;
    saveStatus = 'saved';
  }

  function setLink() {
    if (!editor) return;
    const current = editor.getAttributes('link').href as string | undefined;
    const href = window.prompt(t('admin.editor.linkPrompt'), current ?? 'https://');
    if (href === null) return;
    if (href === '') editor.chain().focus().unsetMark('link').run();
    else if (/^(https?:\/\/|mailto:|\/[^/])/.test(href))
      editor.chain().focus().setMark('link', { href, itemId: null }).run();
    else reason = t('admin.editor.unsafeLink');
  }

  function paste(event: ClipboardEvent): boolean {
    const html = event.clipboardData?.getData('text/html') ?? '';
    const plain = event.clipboardData?.getData('text/plain') ?? '';
    if (!editor || (!html && !plain)) return false;
    const activeEditor = editor;
    const source = html || markdown.render(plain);
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    parsed.querySelectorAll('script,style,iframe,object').forEach((node) => node.remove());
    parsed.querySelectorAll('a[href]').forEach((node) => {
      if (!isSafeHref(node.getAttribute('href') ?? '')) node.removeAttribute('href');
    });
    if (parsed.querySelector('blockquote, img')) {
      const additions: JSONContent[] = [];
      const waiting: Pending[] = [];
      const append = (child: Element) => {
        if (child.matches('blockquote, img')) {
          const id = crypto.randomUUID();
          const type = child.tagName.toLowerCase() === 'img' ? 'image' : 'quote';
          waiting.push({
            id,
            type,
            text: child.textContent?.trim() ?? '',
            source: child.getAttribute('src') ?? '',
            name: '',
            mediaId: '',
            alt: child.getAttribute('alt') ?? '',
            decorative: false,
          });
          additions.push({ type: 'mycelCard', attrs: { blockId: id, blockType: type } });
          return;
        }
        if (child.querySelector('blockquote, img')) {
          for (const part of Array.from(child.childNodes)) {
            if (part.nodeType === Node.TEXT_NODE && part.textContent?.trim()) {
              const paragraph = parsed.createElement('p');
              paragraph.textContent = part.textContent;
              append(paragraph);
            } else if (part instanceof Element) append(part);
          }
          return;
        }
        if (!child.textContent?.trim()) return;
        const id = crypto.randomUUID();
        const wrapper = parsed.createElement('div');
        wrapper.innerHTML = `<section data-mycel-prose data-block-id="${id}"></section>`;
        wrapper.firstElementChild?.append(child.cloneNode(true));
        const prose = PMDOMParser.fromSchema(activeEditor.schema).parse(wrapper).toJSON()
          .content?.[0];
        if (prose?.type === 'mycelProse')
          additions.push({
            ...prose,
            attrs: {
              blockId: id,
              blockType: 'rich-text',
              newBlock: { id, type: 'rich-text', version: 1, props: { content: {} } },
            },
          });
      };
      for (const child of Array.from(parsed.body.children)) append(child);
      const current = editor.getJSON();
      const index = editor.state.doc.resolve(editor.state.selection.from).index(0);
      const content: JSONContent[] = [...(current.content ?? [])] as JSONContent[];
      content.splice(index + 1, 0, ...additions);
      // Adjacent prose is one stored block; keep the first id and every paragraph in order.
      for (let i = 1; i < content.length; i++) {
        if (content[i - 1]?.type === 'mycelProse' && content[i]?.type === 'mycelProse') {
          content[i - 1] = {
            ...content[i - 1],
            content: [...(content[i - 1]?.content ?? []), ...(content[i]?.content ?? [])],
          };
          content.splice(i, 1);
          i -= 1;
        }
      }
      pending = [...pending, ...waiting];
      editor.commands.setContent({ type: 'doc', content });
      reason = t('admin.editor.completeCards');
      return true;
    }
    // TipTap parses only our configured schema; unsupported formatting has no storage route.
    editor.commands.insertContent(parsed.body.innerHTML, {
      parseOptions: { preserveWhitespace: 'full' },
    });
    return true;
  }

  function completeCard(card: Pending) {
    if (
      !editor ||
      (card.type === 'quote' && (!card.text.trim() || !card.name.trim())) ||
      (card.type === 'image' && (!card.mediaId.trim() || (!card.decorative && !card.alt.trim())))
    )
      return;
    const newBlock =
      card.type === 'quote'
        ? {
            id: card.id,
            type: 'quote',
            version: 1,
            props: { text: { [data.locale]: card.text }, attribution: { name: card.name } },
          }
        : {
            id: card.id,
            type: 'image',
            version: 1,
            props: {
              mediaId: card.mediaId,
              decorative: card.decorative,
              alt: card.decorative ? null : { [data.locale]: card.alt },
            },
          };
    const json = editor.getJSON();
    const content = (json.content ?? []).map((node) =>
      node.attrs?.blockId === card.id ? { ...node, attrs: { ...node.attrs, newBlock } } : node
    );
    pending = pending.filter((item) => item.id !== card.id);
    editor.commands.setContent({ type: 'doc', content });
    reason = '';
    schedule();
  }

  onMount(() => {
    let disposed = false;
    let instance: Editor | undefined;
    revisionId = data.revisionId;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (saveStatus !== 'saved' || pending.length) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    // Load the core schemas after articleExtensions has disabled Zod's CSP-hostile JIT probe.
    void import('@mycel/core').then(({ isSafeHref: safeHref }) => {
      if (disposed) return;
      isSafeHref = safeHref;
      const mounted = new Editor({
        element,
        injectCSS: false,
        extensions: articleExtensions,
        content: data.editor as JSONContent,
        editorProps: {
          attributes: { 'aria-label': t('admin.editor.surface') },
          handlePaste: (_view, event) => paste(event),
          handleKeyDown: (_view, event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              void save();
              return true;
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
              event.preventDefault();
              setLink();
              return true;
            }
            if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
              event.preventDefault();
              insertLink?.focus();
              return true;
            }
            if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
              const index = mounted.state.doc.resolve(mounted.state.selection.from).index(0);
              const target = index + (event.key === 'ArrowUp' ? -1 : 1);
              if (target >= 0 && target < mounted.state.doc.childCount) {
                const json = mounted.getJSON();
                const nodes = [...(json.content ?? [])];
                [nodes[index], nodes[target]] = [nodes[target]!, nodes[index]!];
                mounted.commands.setContent({ type: 'doc', content: nodes });
                event.preventDefault();
                return true;
              }
            }
            return false;
          },
        },
        onUpdate: schedule,
      });
      instance = mounted;
      editor = mounted;
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('beforeunload', beforeUnload);
      instance?.destroy();
    };
  });
</script>

<svelte:head><title>{t('admin.editor.title')} · {data.tenant.name}</title></svelte:head>

<main class="page admin writer">
  <h1>{t('admin.editor.title')}</h1>
  <p><a href={base} data-sveltekit-reload>{t('admin.editor.native')}</a></p>
  <div class="field">
    <label for="writing-locale">{t('admin.editor.locale')}</label>
    <select
      id="writing-locale"
      onchange={(event) => {
        window.location.href = `${base}/write?locale=${encodeURIComponent(event.currentTarget.value)}`;
      }}
    >
      {#each data.locales as locale (locale)}
        <option value={locale} selected={locale === data.locale}>{locale}</option>
      {/each}
    </select>
  </div>
  <p role="status" aria-live="polite">
    {t(`admin.editor.state.${saveStatus}`)}{#if saveStatus === 'error'}: {reason}{/if}
  </p>
  {#if saveStatus === 'conflict'}
    <section class="card conflict" aria-labelledby="editor-conflict">
      <h2 id="editor-conflict">{t('admin.content.conflict.title')}</h2>
      <p>{t('admin.editor.conflictHelp')}</p>
      <p>{conflictWho} · {conflictWhen}</p>
      <Diff rows={conflictChanges} locale={data.locale} />
      <h3>{t('admin.editor.mine')}</h3>
      <p>{latestText(editor?.getJSON() ?? null)}</p>
      <h3>{t('admin.editor.theirs')}</h3>
      <p>{latestText(latest)}</p>
      <div class="writer-actions">
        <button type="button" onclick={resolveMine}>{t('admin.editor.keepMine')}</button>
        <button type="button" class="secondary" onclick={resolveLatest}
          >{t('admin.editor.useLatest')}</button
        >
      </div>
    </section>
  {/if}
  {#if reason && saveStatus !== 'error'}<p role="alert">{reason}</p>{/if}
  <div class="writer-layout">
    <section aria-labelledby="writing-heading">
      <h2 id="writing-heading">{t('admin.editor.body')}</h2>
      <div class="writer-actions" role="toolbar" aria-label={t('admin.editor.formatting')}>
        <button type="button" onclick={() => editor?.chain().focus().toggleBold().run()}
          >{t('admin.editor.bold')}</button
        >
        <button type="button" onclick={() => editor?.chain().focus().toggleItalic().run()}
          >{t('admin.editor.italic')}</button
        >
        <button
          type="button"
          onclick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
          >{t('admin.editor.heading')}</button
        >
        <button type="button" onclick={setLink}>{t('admin.editor.link')}</button>
        <button type="button" onclick={() => editor?.commands.undo()}
          >{t('admin.editor.undo')}</button
        >
        <button type="button" onclick={() => editor?.commands.redo()}
          >{t('admin.editor.redo')}</button
        >
      </div>
      <div bind:this={element} class="writing-surface"></div>
      <div class="writer-actions">
        <button type="button" onclick={() => void save()}>{t('admin.editor.save')}</button>
        <a
          bind:this={insertLink}
          class="button secondary"
          data-sveltekit-reload
          href="{base}#insert-type-end">{t('admin.editor.insert')}</a
        >
      </div>
      <p class="muted">{t('admin.editor.shortcuts')}</p>
      {#if data.cards.length}
        <h3>{t('admin.editor.cards')}</h3>
        <ul>
          {#each data.cards as card (card.id)}
            <li>
              <a data-sveltekit-reload href="{base}#block-{card.id}"
                >{card.type} · {t('admin.editor.editCard')}</a
              >
            </li>
          {/each}
        </ul>
      {/if}
      {#each pending as card (card.id)}
        <form
          class="card pending"
          onsubmit={(event) => {
            event.preventDefault();
            completeCard(card);
          }}
        >
          <h3>
            {card.type === 'quote' ? t('admin.editor.quoteStep') : t('admin.editor.imageStep')}
          </h3>
          {#if card.type === 'quote'}
            <div class="field">
              <label for="quote-text-{card.id}">{t('admin.editor.quoteText')}</label><textarea
                id="quote-text-{card.id}"
                bind:value={card.text}
                required
              ></textarea>
            </div>
            <div class="field">
              <label for="quote-name-{card.id}">{t('admin.editor.quoteName')}</label><input
                id="quote-name-{card.id}"
                bind:value={card.name}
                required
              />
            </div>
          {:else}
            <p>{t('admin.editor.imageSource')}: {card.source}</p>
            <MediaPicker
              id="media-{card.id}"
              name="media-{card.id}"
              label={t('admin.block.field.mediaId')}
              locale={data.locale}
              value={card.mediaId}
              options={data.media}
              base="/admin/{data.tenant.slug}"
              upload={data.upload}
              onchange={(id: string) => (card.mediaId = id)}
            />
            <div class="check">
              <input
                type="checkbox"
                id="decorative-{card.id}"
                bind:checked={card.decorative}
              /><label for="decorative-{card.id}">{t('admin.editor.decorative')}</label>
            </div>
            {#if !card.decorative}<div class="field">
                <label for="alt-{card.id}">{t('admin.editor.alt')}</label><input
                  id="alt-{card.id}"
                  bind:value={card.alt}
                  required
                />
              </div>{/if}
          {/if}
          <button type="submit">{t('admin.editor.completeCard')}</button>
        </form>
      {/each}
    </section>
    <aside aria-labelledby="editor-suggestions">
      <h2 id="editor-suggestions">{t('admin.editor.suggestions')}</h2>
      {#if !data.missingAlt.length && !data.missingTranslations.length}
        <p>{t('admin.editor.noSuggestions')}</p>
      {/if}
      {#each data.missingAlt as id (id)}
        {#if !ignored.includes(id)}
          <div class="card">
            <p>{t('admin.editor.missingAlt')}</p>
            <div class="writer-actions">
              <a class="button secondary" data-sveltekit-reload href="{base}#block-{id}"
                >{t('admin.editor.adjust')}</a
              >
              <button type="button" onclick={() => (ignored = [...ignored, id])}
                >{t('admin.editor.ignore')}</button
              >
            </div>
          </div>
        {/if}
      {/each}
      {#each data.missingTranslations as locale (locale)}
        {#if !ignored.includes(locale)}
          <div class="card">
            <p>{t('admin.editor.missingTranslation')} ({locale})</p>
            <div class="writer-actions">
              <a class="button secondary" href="{base}/write?locale={locale}"
                >{t('admin.editor.adjust')}</a
              >
              <button type="button" onclick={() => (ignored = [...ignored, locale])}
                >{t('admin.editor.ignore')}</button
              >
            </div>
          </div>
        {/if}
      {/each}
    </aside>
  </div>
</main>

<style>
  .writer {
    max-width: 90rem;
  }
  .writer-layout {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(15rem, 1fr);
    gap: 2rem;
  }
  .writer-layout > * {
    min-width: 0;
  }
  .writer-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .writer-actions > * {
    min-height: 44px;
    min-width: 0;
    max-width: 100%;
    white-space: normal;
  }
  .writing-surface {
    border: 1px solid currentColor;
    border-radius: 0.25rem;
    padding: 1rem;
    min-height: 20rem;
    overflow-wrap: anywhere;
  }
  .writing-surface :global(.ProseMirror) {
    position: relative;
    white-space: break-spaces;
    font-variant-ligatures: none;
    min-height: 18rem;
    outline-offset: 0.25rem;
  }
  .writing-surface :global(.editor-prose) {
    margin-block: 1rem;
  }
  .writing-surface :global(.editor-card) {
    border: 1px solid currentColor;
    border-radius: 0.25rem;
    padding: 1rem;
    margin-block: 1rem;
  }
  @media (max-width: 48rem) {
    .writer-layout {
      grid-template-columns: 1fr;
    }
  }
</style>
