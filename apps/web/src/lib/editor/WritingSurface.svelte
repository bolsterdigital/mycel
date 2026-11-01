<!-- A progressive view of the one document form. The native fields remain the no-JavaScript
     path; this surface only adds a JSON field, never an autosave endpoint or a second revision. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { articleExtensions, proseExtensions } from './article-extensions.js';
  import { Editor, type JSONContent } from '@tiptap/core';
  import MarkdownIt from 'markdown-it';
  import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
  import { parseInert, withoutLineBreakNodes } from './inert-html.js';
  import { Actions, Button, MediaPicker } from '#lib/admin/ui/index.js';
  import type { MediaChoice } from '#lib/admin/media-choice.js';
  import { ui } from '../../i18n/index.js';

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
  }: {
    content: unknown;
    name: string;
    locale: string;
    contentLocale: string;
    media?: readonly MediaChoice[];
    base?: string;
    upload?: boolean;
    article?: boolean;
    fallback?: boolean;
    nativeId?: string;
    value?: string;
  } = $props();
  const t = $derived(ui(locale));
  let host: HTMLDivElement;
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
    decorative: boolean;
  };
  let pending = $state<Pending[]>([]);
  const markdown = new MarkdownIt({ html: false, linkify: false });

  function setLink() {
    if (!editor) return;
    const current = editor.getAttributes('link').href as string | undefined;
    const href = window.prompt(t('admin.editor.linkPrompt'), current ?? 'https://');
    if (href === null) return;
    if (href === '') editor.chain().focus().unsetMark('link').run();
    else if (isSafeHref(href)) editor.chain().focus().setMark('link', { href, itemId: null }).run();
    else reason = t('admin.editor.unsafeLink');
  }

  function paste(event: ClipboardEvent): boolean {
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
            props: { text: { [data.contentLocale]: card.text }, attribution: { name: card.name } },
          }
        : {
            id: card.id,
            type: 'image',
            version: 1,
            props: {
              mediaId: card.mediaId,
              decorative: card.decorative,
              alt: card.decorative ? null : { [data.contentLocale]: card.alt },
            },
          };
    const json = editor.getJSON();
    const content = (json.content ?? []).map((node) =>
      node.attrs?.blockId === card.id ? { ...node, attrs: { ...node.attrs, newBlock } } : node
    );
    pending = pending.filter((item) => item.id !== card.id);
    editor.commands.setContent({ type: 'doc', content });
    reason = '';
    sync();
  }

  function sync() {
    if (!editor) return;
    const json = editor.getJSON();
    payload = JSON.stringify(json);
  }
  onMount(() => {
    if (fallback || (!article && host.closest('[data-native-prose]'))) return;
    void import('@mycel/core').then((core) => {
      isSafeHref = core.isSafeHref;
    });
    let initial = content;
    try {
      if (value) initial = JSON.parse(value);
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
      ).map((card) => [card.id.replace('block-', ''), card.closest('.ui-block-card') ?? card])
    );
    // A card's "+" stands above it, in the fieldset's place: both move into the writer together,
    // or every "+" stays stacked under the text with nothing to say where it inserts.
    const inserts = new Map<Element, Element>();
    for (const card of cards.values()) {
      const field = card.closest('fieldset.native-block');
      const insert = field?.previousElementSibling;
      if (insert?.matches('details.ui-block-insert')) inserts.set(card, insert);
    }
    const instance = new Editor({
      element: host,
      injectCSS: false,
      extensions: article ? articleExtensions : proseExtensions,
      content: initial as JSONContent,
      editorProps: {
        handlePaste: (_view, event) => paste(event),
        attributes: { 'aria-label': t('admin.editor.surface'), lang: contentLocale },
      },
      onUpdate: ({ editor: current }) => {
        const json = current.getJSON();
        payload = JSON.stringify(json);
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
                cards.get(node.attrs.blockId);
              if (card) {
                const whole = card.closest('.ui-block-card') ?? card;
                const insert = inserts.get(whole);
                if (insert) dom.append(insert);
                dom.append(whole);
              } else dom.textContent = node.attrs.blockType ?? '';
              return { dom, stopEvent: () => true, ignoreMutation: () => true };
            },
          }
        : {},
    });
    editor = instance;
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
    // Preserve untouched documents byte-for-byte. Only onUpdate activates the posted JSON.
    payload = value;
    active = true;
    const form = host.closest('form');
    const check = (event: SubmitEvent) => {
      if (pending.length) {
        event.preventDefault();
        reason = t('admin.editor.completeCards');
      }
    };
    form?.addEventListener('submit', check);
    return () => {
      form?.removeEventListener('submit', check);
      instance.destroy();
    };
  });
</script>

<input type="hidden" {name} value={payload} />
<div class="writing" class:active>
  <div class="writing-actions" hidden={!active} aria-label={t('admin.editor.formatting')}>
    <Actions>
      <Button
        variant="secondary"
        type="button"
        onclick={() => editor?.chain().focus().toggleBold().run()}>{t('admin.editor.bold')}</Button
      >
      <Button
        variant="secondary"
        type="button"
        onclick={() => editor?.chain().focus().toggleItalic().run()}
        >{t('admin.editor.italic')}</Button
      >
      <Button
        variant="secondary"
        type="button"
        onclick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
        >{t('admin.editor.heading')}</Button
      >
      <Button variant="secondary" type="button" onclick={setLink}>{t('admin.editor.link')}</Button>
      <Button variant="secondary" type="button" onclick={() => editor?.commands.undo()}
        >{t('admin.editor.undo')}</Button
      >
      <Button variant="secondary" type="button" onclick={() => editor?.commands.redo()}
        >{t('admin.editor.redo')}</Button
      >
    </Actions>
  </div>
  <div bind:this={host} class="writing-surface" hidden={!active}></div>
  {#if reason}<p role="alert">{reason}</p>{/if}
  {#each pending as card (card.id)}
    <fieldset class="card pending">
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
          <input type="checkbox" id="decorative-{card.id}" bind:checked={card.decorative} /><label
            for="decorative-{card.id}">{t('admin.editor.decorative')}</label
          >
        </div>
        {#if !card.decorative}<div class="field">
            <label for="alt-{card.id}">{t('admin.editor.alt')}</label><input
              id="alt-{card.id}"
              bind:value={card.alt}
              required
            />
          </div>{/if}
      {/if}
      <Button type="button" onclick={() => completeCard(card)}
        >{t('admin.editor.completeCard')}</Button
      >
    </fieldset>
  {/each}
</div>

<style>
  .writing-actions[hidden],
  .writing-surface[hidden] {
    display: none;
  }
  .writing-surface {
    max-inline-size: 70ch;
    min-width: 0;
  }
  .writing-surface :global(.ProseMirror) {
    min-height: 10rem;
    white-space: break-spaces;
    overflow-wrap: anywhere;
    outline-offset: 0.25rem;
  }
  .writing-surface :global(.editor-prose) {
    margin-block: 1rem;
  }
  .writing-surface :global(.editor-card) {
    white-space: normal;
    margin-block: 1rem;
  }
</style>
