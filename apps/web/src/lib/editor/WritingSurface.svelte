<!-- A progressive view of the one document form. The native fields remain the no-JavaScript
     path; this surface only adds a JSON field, never an autosave endpoint or a second revision. -->
<script lang="ts">
  import { removedArticleCards, type ArticleEditorDocument } from './article-document.js';
  import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
  import { onMount, tick, type Snippet } from 'svelte';
  import { articleExtensions, proseExtensions } from './article-extensions.js';
  import { Editor, type JSONContent } from '@tiptap/core';
  import MarkdownIt from 'markdown-it';
  import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
  import { parseInert, withoutLineBreakNodes } from './inert-html.js';
  import HeroAltRow from '#lib/admin/hero-alt/HeroAltRow.svelte';
  import { imageAltProps } from '#lib/admin/hero-alt/hero-alt.js';
  import { Actions, Button, Icon, MediaPicker, WritingSheet } from '#lib/admin/ui/index.js';
  import type { MediaChoice } from '#lib/admin/media-choice.js';
  import { dropIndex, type DropIndex } from './drop-index.js';
  import FormatBar from './FormatBar.svelte';
  import SelectionTools from './SelectionTools.svelte';
  import { Formatting } from './formatting.svelte.js';
  import { fill, ui } from '../../i18n/index.js';

  let {
    content,
    name,
    locale,
    contentLocale,
    article = false,
    fallback = false,
    nativeId,
    value = '',
    media = [],
    base = '',
    upload = false,
    splitProse = false,
    preview,
    native,
  }: {
    content: unknown;
    name: string;
    locale: string;
    contentLocale: string;
    media?: readonly MediaChoice[];
    base?: string;
    upload?: boolean;
    /** A dropped image may split a text block: only while the item has one locale. */
    splitProse?: boolean;
    preview?: Snippet;
    native?: Snippet;
    article?: boolean;
    fallback?: boolean;
    nativeId?: string;
    value?: string;
  } = $props();
  const t = $derived(ui(locale));
  let host: HTMLDivElement;
  let frame = $state<HTMLDivElement>();
  let editor = $state<Editor | null>(null);
  let payload = $state('');
  let active = $state(false);
  let reason = $state('');
  const data = $derived({
    contentLocale,
    locale,
    media,
    upload,
    tenant: { slug: base.split('/').at(-1) ?? '' },
  });
  let isSafeHref: typeof import('@mycel/core').isSafeHref = () => false;
  type Pending = {
    id: string;
    type: 'quote' | 'image';
    text: string;
    source: string;
    name: string;
    mediaId: string;
    alt: string;
    /** Dropped or pasted as a file: its upload's progress, null once it is done. */
    progress?: number | null;
    error?: string;
  };
  let pending = $state<Pending[]>([]);
  /** Images this surface uploaded, so their cards' pickers show them before a reload. */
  let added = $state<MediaChoice[]>([]);
  const choices = $derived([...added, ...media.filter((m) => !added.some((a) => a.id === m.id))]);
  // Reads pasted plain text, which was written elsewhere (ADR 020 rule 9). Rejected: core
  // `fromMarkdown`, whose lossless grammar has no quote or image and turns every `_` and `**` into
  // a toggle, so `snake_case_name` would lose its underscores.
  const markdown = new MarkdownIt({ html: false, linkify: false });
  /** The shared upload of the admin's scripts (`static/_admin/upload-file.js`), loaded on use. */
  const UPLOAD = '/_admin/upload-file.js';
  /** A placed image until the save: its thumbnail and alt text, as the card at rest shows them. */
  function placed(block: { props: { mediaId: string; alt: Record<string, string> | null } }) {
    const figure = document.createElement('figure');
    figure.className = 'editor-placed';
    const img = document.createElement('img');
    img.src = `${base}/media/${block.props.mediaId}/thumb`;
    img.alt = '';
    const words = document.createElement('figcaption');
    words.textContent = block.props.alt?.[contentLocale] ?? t('admin.editor.decorative');
    figure.append(img, words);
    return figure;
  }

  const formatting = new Formatting(
    (href) => isSafeHref(href),
    () => t('admin.editor.unsafeLink')
  );

  function paste(event: ClipboardEvent): boolean {
    const files = [...(event.clipboardData?.files ?? [])];
    if (article && upload && editor && files.length) {
      const index = editor.state.doc.resolve(editor.state.selection.from).index(0);
      void placeFiles(files, { index: index + 1, split: null });
      return true;
    }
    const html = event.clipboardData?.getData('text/html') ?? '';
    const plain = event.clipboardData?.getData('text/plain') ?? '';
    if (!editor || (!html && !plain)) return false;
    const activeEditor = editor;
    const source = html || markdown.render(plain);
    const parsed = parseInert(source);
    parsed.querySelectorAll('script,style,iframe,object').forEach((node) => node.remove());
    parsed.querySelectorAll('a[href]').forEach((node) => {
      if (!isSafeHref(node.getAttribute('href') ?? '')) node.removeAttribute('href');
    });
    if (!article && parsed.querySelector('blockquote, img')) return false;
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
        const section = wrapper.appendChild(parsed.createElement('section'));
        section.setAttribute('data-mycel-prose', '');
        section.setAttribute('data-block-id', id);
        section.append(child.cloneNode(true));
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
    // Parsed here, not by TipTap: a string would reach its own DOMParser, a Trusted Types sink.
    editor.commands.insertContent(
      PMDOMParser.fromSchema(editor.schema).parseSlice(withoutLineBreakNodes(parsed.body), {
        preserveWhitespace: 'full',
      }).content
    );
    return true;
  }

  async function completeCard(card: Pending) {
    if (
      !editor ||
      card.progress != null ||
      (card.type === 'quote' && (!card.text.trim() || !card.name.trim())) ||
      (card.type === 'image' && !card.mediaId.trim())
    )
      return;
    const newBlock =
      card.type === 'quote'
        ? {
            id: card.id,
            type: 'quote',
            version: 1,
            props: { text: { [data.contentLocale]: card.text }, attribution: { name: card.name } },
          }
        : {
            id: card.id,
            type: 'image',
            version: 1,
            props: {
              mediaId: card.mediaId,
              ...imageAltProps(card.alt.trim() ? { [data.contentLocale]: card.alt } : null),
            },
          };
    pending = pending.filter((item) => item.id !== card.id);
    // Its fields leave the document first, so the card's view is built without them.
    await tick();
    const json = editor.getJSON();
    const content = (json.content ?? []).map((node) =>
      node.attrs?.blockId === card.id ? { ...node, attrs: { ...node.attrs, newBlock } } : node
    );
    editor.commands.setContent({ type: 'doc', content });
    reason = '';
    sync();
  }

  /** A pending card nobody wants: its place in the text goes with it. */
  async function removeCard(card: Pending) {
    if (!editor) return;
    pending = pending.filter((item) => item.id !== card.id);
    await tick();
    const content = (editor.getJSON().content ?? []).filter((n) => n.attrs?.blockId !== card.id);
    editor.commands.setContent({ type: 'doc', content });
    if (!pending.length) reason = '';
    sync();
  }

  /**
   * Files dropped or pasted in the writer: a card per file at the place, at once, each with
   * its upload's progress and then its picture, alt text in focus. The same route as the media
   * picker's upload; a file that is no image stays in Media and its card goes. Rejected: waiting
   * for the uploads before showing anything, which leaves a drop without an answer.
   */
  async function placeFiles(files: File[], at: DropIndex) {
    if (!editor || !files.length) return;
    const cards: Pending[] = files.map((file) => ({
      id: crypto.randomUUID(),
      type: 'image',
      text: '',
      source: file.name,
      name: '',
      mediaId: '',
      alt: '',
      progress: 0,
    }));
    pending = [...pending, ...cards];
    reason = t('admin.editor.completeCards');
    // The cards' fields exist before the document asks for them at their place.
    await tick();
    const content = [...(editor.getJSON().content ?? [])] as JSONContent[];
    const nodes = cards.map((c) => ({
      type: 'mycelCard',
      attrs: { blockId: c.id, blockType: 'image' },
    }));
    const prose = content[at.index - 1];
    if (at.split !== null && prose?.type === 'mycelProse') {
      const rest = (prose.content ?? []).slice(at.split);
      content[at.index - 1] = { ...prose, content: (prose.content ?? []).slice(0, at.split) };
      // The rest is a block of its own; the writer's identity plugin gives it its id.
      content.splice(at.index, 0, ...nodes, { type: 'mycelProse', content: rest });
    } else content.splice(at.index, 0, ...nodes);
    editor.commands.setContent({ type: 'doc', content });
    sync();
    // The screen counts this as a change: leaving now asks, as after typing.
    host.dispatchEvent(new Event('change', { bubbles: true }));
    const { send, isImage } = await import(/* @vite-ignore */ UPLOAD);
    let focused = false;
    for (const [i, file] of files.entries()) {
      const card = pending.find((c) => c.id === cards[i]!.id);
      if (!card) continue;
      const result = await send(`${base}/media/upload`, file, (value: number) => {
        card.progress = value;
      });
      card.progress = null;
      if (result.choice && !isImage(result.choice)) {
        await removeCard(card);
        reason = fill(t('admin.block.drop.notImage'), { filename: file.name });
        continue;
      }
      if (!result.choice) {
        card.error = `${file.name}: ${result.error || t('admin.media.picker.failed')}`;
        continue;
      }
      added = [result.choice, ...added];
      card.mediaId = result.choice.id;
      if (focused) continue;
      focused = true;
      await tick();
      const alt = document.getElementById(`alt-${card.id}`);
      const description = alt?.closest('details');
      if (description) description.open = true;
      alt?.focus();
    }
  }

  let removedCardIds: string[] = [];
  let userEdit = false;
  function noteUserEdit() {
    userEdit = true;
    // DOM input is read by ProseMirror's mutation observer after the input event returns.
    setTimeout(() => {
      userEdit = false;
    }, 0);
    return false;
  }

  function sync() {
    if (!editor) return;
    const json = editor.getJSON();
    payload = JSON.stringify(
      article ? { ...json, content: json.content ?? [], removedCardIds } : json
    );
  }
  onMount(() => {
    if (fallback || (!article && host.closest('[data-native-prose]'))) return;
    void import('@mycel/core').then((core) => {
      isSafeHref = core.isSafeHref;
    });
    let initial = content;
    try {
      if (value) {
        initial = JSON.parse(value);
        // A refused form post returns the same payload. Keep its visible removals on the next edit.
        const removed = (initial as ArticleEditorDocument).removedCardIds;
        removedCardIds = Array.isArray(removed)
          ? removed.filter((id) => typeof id === 'string')
          : [];
      }
    } catch {
      return;
    }
    // The `block-<id>` target is a card's fold, or the card itself when a type has no fields (a
    // paywall) and so no fold. Rejected: the folds alone, which left such a card without its "+".
    const cards = new Map(
      Array.from(
        host
          .closest('form')
          ?.querySelectorAll<HTMLElement>('details.block, .ui-block-card[id^="block-"]') ?? []
      ).map((card) => [
        card.id.replace(/^(?:native-)?block-/, ''),
        card.closest('.ui-block-card') ?? card,
      ])
    );
    // A card's "+" stands above it, in the fieldset's place: both move into the writer together,
    // or every "+" stays stacked under the text with nothing to say where it inserts.
    const inserts = new Map<Element, Element>();
    for (const card of cards.values()) {
      const field = card.closest('fieldset.native-block');
      const insert = field?.previousElementSibling;
      if (insert?.matches('details.ui-block-insert')) inserts.set(card, insert);
    }
    // The SSR preview has already laid out these words and cards. Preserve card references above,
    // then let TipTap own the same host instead of appending a second copy of the document.
    if (preview) host.replaceChildren();
    const baseCardIds = new Set([
      ...removedCardIds,
      ...((initial as ArticleEditorDocument).content ?? [])
        .filter((node) => node.type === 'mycelCard')
        .map((node) => node.attrs.blockId),
    ]);
    const instance = new Editor({
      element: host,
      injectCSS: false,
      extensions: article ? articleExtensions : proseExtensions,
      content: initial as JSONContent,
      editorProps: {
        handleDOMEvents: {
          keydown: noteUserEdit,
          beforeinput: noteUserEdit,
          cut: noteUserEdit,
          paste: noteUserEdit,
        },
        handlePaste: (_view, event) => paste(event),
        // The shortcut the screen's help names for a link; the other marks have TipTap's own.
        handleKeyDown: (view, event) => {
          // Keep emptied prose identities so other locales survive selecting and deleting all.
          // Cards disappear visibly; a missing prose id must still be refused by the server.
          if (
            article &&
            view.state.selection instanceof AllSelection &&
            ['Backspace', 'Delete'].includes(event.key)
          ) {
            event.preventDefault();
            const prose = [];
            for (const node of view.state.doc.content.content)
              if (node.type.name === 'mycelProse')
                prose.push(
                  node.type.create(node.attrs, view.state.schema.nodes.paragraph!.create())
                );
            view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, prose));
            return true;
          }
          if (
            article &&
            view.state.selection instanceof NodeSelection &&
            view.state.selection.node.type.name === 'mycelCard' &&
            event.key.length === 1 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            // Reuse adjacent prose instead of creating a second locale-incomplete block.
            // A new Dutch-only block beside existing English words cannot be merged losslessly.
            const { from, to, $from: beforeSelection } = view.state.selection;
            const next = view.state.doc.nodeAt(to);
            const previous = beforeSelection.nodeBefore;
            if (next?.type.name === 'mycelProse' || previous?.type.name === 'mycelProse') {
              const transaction = view.state.tr.deleteSelection();
              const position = Math.min(from, transaction.doc.content.size);
              const bias = next?.type.name === 'mycelProse' ? 1 : -1;
              transaction.setSelection(TextSelection.near(transaction.doc.resolve(position), bias));
              view.dispatch(transaction.insertText(event.key));
              return true;
            }
            const id = crypto.randomUUID();
            const schema = view.state.schema;
            const prose = schema.nodes.mycelProse!.create(
              {
                blockId: id,
                newBlock: { id, type: 'rich-text', version: 1, props: { content: {} } },
              },
              schema.nodes.paragraph!.create(null, schema.text(event.key))
            );
            view.dispatch(view.state.tr.replaceSelectionWith(prose));
            return true;
          }
          if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'k')
            return false;
          event.preventDefault();
          formatting.openLink();
          return true;
        },
        // The cursor stays clear of the bars that stay in view above the text.
        scrollMargin: { top: 128, right: 0, bottom: 48, left: 0 },
        scrollThreshold: { top: 128, right: 0, bottom: 48, left: 0 },
        handleDrop: (view, event, _slice, moved) => {
          const files = [...(event.dataTransfer?.files ?? [])];
          if (moved || !article || !upload || !files.length) return false;
          event.preventDefault();
          void placeFiles(files, dropIndex(view, event, splitProse));
          return true;
        },
        attributes: {
          'aria-label': t('admin.editor.surface'),
          lang: contentLocale,
          class: 'writing-document',
        },
      },
      onTransaction: ({ editor: current, transaction }) => {
        if (!article || !transaction.docChanged) return;
        removedCardIds = removedArticleCards(
          transaction.before.toJSON() as ArticleEditorDocument,
          current.getJSON() as unknown as ArticleEditorDocument,
          removedCardIds,
          userEdit
        ).filter((id) => baseCardIds.has(id));
      },
      onUpdate: ({ editor: current }) => {
        const json = current.getJSON();
        payload = JSON.stringify(
          article ? { ...json, content: json.content ?? [], removedCardIds } : json
        );
      },
    });
    // TipTap installs extension node views at creation; set the native form portals afterwards.
    instance.view.setProps({
      nodeViews: article
        ? {
            mycelCard: (node) => {
              const dom = document.createElement('div');
              dom.className = 'editor-card';
              dom.dataset.blockId = node.attrs.blockId;
              dom.dataset.blockType = node.attrs.blockType;
              dom.contentEditable = 'false';
              const card =
                document.getElementById(`block-${node.attrs.blockId}`) ??
                document.getElementById(`pending-${node.attrs.blockId}`) ??
                cards.get(node.attrs.blockId);
              if (card) {
                const whole = card.closest('.ui-block-card') ?? card;
                const insert = inserts.get(whole);
                if (insert) dom.append(insert);
                dom.append(whole);
              } else if (node.attrs.newBlock?.type === 'image')
                dom.append(placed(node.attrs.newBlock));
              else dom.textContent = node.attrs.blockType ?? '';
              return { dom, stopEvent: () => true, ignoreMutation: () => true };
            },
          }
        : {},
    });
    editor = instance;
    const unfollow = formatting.attach(instance);
    if (article) {
      host
        .closest('form')
        ?.querySelectorAll<HTMLFieldSetElement>('[data-native-prose]')
        .forEach((field) => {
          field.disabled = true;
          field.hidden = true;
        });
      // What the cards left behind: their empty fieldsets, and the "+" before prose, which is one
      // text here and has no place for it.
      for (const field of host
        .closest('form')
        ?.querySelectorAll<HTMLElement>('fieldset.native-block') ?? []) {
        if (!field.querySelector('.ui-block-card')) field.hidden = true;
        const insert = field.previousElementSibling;
        if (insert?.matches('details.ui-block-insert')) (insert as HTMLElement).hidden = true;
      }
    } else if (nativeId) {
      const native = document.getElementById(nativeId);
      if (native) native.hidden = true;
    }
    // A link in a refusal summary names the hidden textarea, which takes no focus: the editor does
    // (#130). Rejected: moving the id here, which unlabels the textarea that still posts the field.
    // The article writer has no textarea; its link names the surface below.
    const anchor = nativeId ?? (article ? name : undefined);
    const toField = (event: MouseEvent) => {
      if (!anchor || !(event.target instanceof Element)) return;
      const link = event.target.closest(`a[href="#${CSS.escape(anchor)}"]`);
      if (link) instance.commands.focus();
    };
    document.addEventListener('click', toField);
    // Preserve untouched documents byte-for-byte. Only onUpdate activates the posted JSON.
    payload = value;
    active = true;
    const form = host.closest('form');
    // A drop elsewhere on the screen comes here, to the end (`static/_admin/block-drop.js`).
    const dropped = (event: Event) => {
      const files = (event as CustomEvent<{ files: File[] }>).detail?.files ?? [];
      void placeFiles(files, { index: instance.state.doc.childCount, split: null });
    };
    host.addEventListener('mycel:files', dropped);
    const check = (event: SubmitEvent) => {
      if (pending.length) {
        event.preventDefault();
        reason = t('admin.editor.completeCards');
      }
    };
    form?.addEventListener('submit', check);
    return () => {
      form?.removeEventListener('submit', check);
      host.removeEventListener('mycel:files', dropped);
      document.removeEventListener('click', toField);
      unfollow();
      instance.destroy();
    };
  });
</script>

{#snippet nativeStyle()}
  {#if native}
    <details
      class="writing-native"
      data-native-article
      hidden={active}
      aria-hidden={active ? 'true' : undefined}
      open={fallback}
    >
      <summary><Icon name="chevron-down" /><span>{t('admin.editor.editFields')}</span></summary>
      {@render native()}
    </details>
  {/if}
{/snippet}

<input type="hidden" {name} value={payload} />
<div class="writing" id={article ? name : undefined} class:active bind:this={frame}>
  <WritingSheet hidden={!active && !preview}>
    {#snippet toolbar()}
      <div class="writing-actions" hidden={!active && !preview}>
        <FormatBar
          {formatting}
          {locale}
          disabled={!active}
          styleAlternative={native ? nativeStyle : undefined}
        />
      </div>
    {/snippet}
    <div
      bind:this={host}
      class="writing-surface"
      hidden={!active && !preview}
      data-article-writer={article ? '' : undefined}
    >
      {#if preview}<div class="writing-preview writing-document" lang={contentLocale}>
          {@render preview()}
        </div>{/if}
    </div>
  </WritingSheet>

  {#if active}<SelectionTools {formatting} {locale} {frame} id={nativeId ?? name} />{/if}
  {#if reason}<p role="alert">{reason}</p>{/if}
  {#each pending as card (card.id)}
    <fieldset class="card pending" id="pending-{card.id}">
      <h3>
        {card.type === 'quote'
          ? t('admin.editor.quoteStep')
          : card.progress !== undefined
            ? t('admin.editor.imageAdded')
            : t('admin.editor.imageStep')}
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
        {#if card.progress != null}
          <p>
            <label for="progress-{card.id}"
              >{fill(t('admin.media.picker.uploading'), { filename: card.source })}</label
            >
            <progress id="progress-{card.id}" max="100" value={card.progress}></progress>
          </p>
        {:else if card.error}
          <p class="ui-error" role="alert">{card.error}</p>
        {:else if card.progress === undefined}
          <p>{t('admin.editor.imageSource')}: {card.source}</p>
        {/if}
        <MediaPicker
          id="media-{card.id}"
          name="media-{card.id}"
          label={t('admin.block.field.mediaId')}
          locale={data.locale}
          value={card.mediaId}
          options={choices}
          base="/admin/{data.tenant.slug}"
          upload={data.upload}
          onchange={(id: string) => (card.mediaId = id)}
        />
        <HeroAltRow
          locale={data.locale}
          work={data.contentLocale}
          locales={[data.contentLocale]}
          image={card.mediaId}
          savedImage=""
          text={card.alt}
          savedText=""
          others={{}}
          fieldId={`alt-${card.id}`}
          fieldName={`alt-${card.id}`}
          clearName={`clear-${card.id}`}
          markerName={`shown-${card.id}`}
          block
          clientManaged
          ontext={(text) => (card.alt = text)}
        />
      {/if}
      <Actions>
        <Button type="button" onclick={() => completeCard(card)}
          >{t('admin.editor.completeCard')}</Button
        >
        <Button variant="secondary" type="button" onclick={() => removeCard(card)}
          >{t('admin.editor.removeCard')}</Button
        >
      </Actions>
    </fieldset>
  {/each}
</div>

<style>
  .writing-actions[hidden],
  .writing-surface[hidden] {
    display: none;
  }
  /* A dropped file's name has no break point (`IMG_20261106_123456.jpg`), and a progress bar is
     10em wide by default, 320 px at 200% text: both stay inside the card on a narrow screen. */
  .pending p {
    overflow-wrap: anywhere;
  }
  .pending progress {
    display: block;
    inline-size: 100%;
  }
  /* While the document bar stays in view, so does the formatting bar of the text being read: in
     a long text the bar above it was a scroll away. It stops with its own sheet. Under the same
     condition as the document bar (`.ui-item-bar` in ui.css), so the two never cover a narrow
     or short screen, or a screen at 200% text, together. Rejected: always sticky, which took a
     third of a 320 px screen once the bar wrapped. */
  @media (min-width: 48rem) and (min-height: 36rem), (min-width: 60rem) and (min-height: 24rem) {
    .writing :global(.ui-writing-sheet-toolbar) {
      position: sticky;
      inset-block-start: var(--item-bar-block-size, 0px);
      z-index: 3;
      background: var(--color-surface-bg);
      border-radius: var(--radius) var(--radius) 0 0;
    }
  }
  /* The selection bar and the link field are placed in this frame, at the words. */
  .writing {
    position: relative;
  }
  /* The native disclosure fills the style control's intrinsic grid slot. It remains measured
     but inert after enhancement; the live select then fills exactly that same space. */
  .writing-native > summary {
    display: flex;
    align-items: center;
    gap: var(--space-0);
    min-block-size: var(--tap);
    padding-inline: 0.35em;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius);
    color: var(--color-link);
    font: inherit;
    font-weight: 600;
    white-space: normal;
    hyphens: manual;
    list-style: none;
    cursor: pointer;
  }
  .writing-native > summary :global(svg) {
    flex-shrink: 0;
  }
  .writing-native > summary span {
    min-inline-size: 0;
    overflow-wrap: normal;
  }
  .writing-native > summary::-webkit-details-marker {
    display: none;
  }
  .writing-native[hidden] {
    display: block;
    visibility: hidden;
  }
  .writing:has(:global(.writing-native[open]:not([hidden]))) :global(.ui-writing-sheet-content) {
    display: none;
  }
  .writing:has(:global(.writing-native[open]:not([hidden]))) :global(.ui-writing-sheet-toolbar) {
    position: static;
  }
  .writing-surface :global(.editor-pending-range) {
    color: var(--color-selected-fg);
    background: var(--color-selected-bg);
    outline: var(--border-width) solid currentColor;
  }
  .writing-surface {
    max-inline-size: 70ch;
    min-width: 0;
  }
  .writing-surface :global(.writing-document) {
    min-height: 10rem;
    /* Chromium gives contenteditable after-white-space line breaking. Match ordinary SSR text,
       or identical paragraphs wrap differently when the editor claims them. */
    line-break: auto;
    white-space: break-spaces;
    overflow-wrap: anywhere;
    outline-offset: 0.25rem;
  }
  .writing-surface :global(:is(.editor-prose, .writing-prose-preview)[data-through])::before {
    content: attr(data-through-locale) ': ' attr(data-through);
    display: block;
    color: var(--color-muted);
    font-style: italic;
    pointer-events: none;
    user-select: none;
  }
  .writing:not(.active) .writing-surface :global(.writing-document) {
    white-space: normal;
  }
  .writing:not(.active) .writing-surface :global(:is(.editor-prose, .writing-prose-preview) p) {
    white-space: break-spaces;
  }
  .writing-surface :global(:is(.editor-prose, .writing-prose-preview)) {
    margin-block: 1rem;
  }
  .writing-surface :global(.editor-card) {
    white-space: normal;
    margin-block: 1rem;
  }
  .writing-surface :global(.editor-placed) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
  }
  .writing-surface :global(.editor-placed img) {
    inline-size: 8rem;
    block-size: auto;
  }
</style>
