<!-- The e-mail preview of one item: the subject, the mail as a recipient's client
     shows it, in a frame of its own (its inline styles need their own policy), and the text part
     under a disclosure. A link per language; works without JavaScript. The frame is sandboxed
     without `allow-same-origin`, so its document has an opaque origin and cannot reach the admin;
     `allow-scripts` is there only so accessibility checks can enter it, since the frame's own
     policy (`EMAIL_FRAME_POLICY`) refuses every script anyway. -->
<script lang="ts">
  import { MetaList, SubNav } from '#lib/admin/ui/index.js';
  import { languageName } from '#lib/admin/format.js';
  import { fill, ui } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/content/${data.item.id}`);
  const title = $derived(data.item.title || t('admin.content.untitled'));
</script>

<svelte:head>
  <title>{t('admin.email.preview')} · {title} · {t('admin.title')}</title>
</svelte:head>

<main class="page admin email-preview">
  <h1>{fill(t('admin.email.preview.title'), { title })}</h1>
  <p><a href={base}>{t('admin.email.preview.back')}</a></p>
  <p class="ui-hint">{t('admin.email.preview.hint')}</p>
  {#if data.locales.length > 1}
    <SubNav
      label={t('admin.email.preview.locales')}
      items={data.locales.map((l) => ({
        href: `${base}/email?locale=${l}`,
        label: languageName(l),
        current: l === data.work,
      }))}
    />
  {/if}
  <MetaList items={[{ term: t('admin.email.preview.subject'), value: data.subject }]} />
  <iframe
    class="email-frame"
    src={data.frame}
    title={fill(t('admin.email.preview.frame'), { title })}
    sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
  ></iframe>
  <details class="email-text">
    <summary>{t('admin.email.preview.text')}</summary>
    <pre>{data.text}</pre>
  </details>
</main>

<style>
  .email-frame {
    display: block;
    inline-size: 100%;
    block-size: min(80dvh, 60rem);
    margin-block: 1rem;
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius);
  }
  .email-text pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-inline-size: 72ch;
  }
</style>
