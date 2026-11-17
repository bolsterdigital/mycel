<!-- The confirmation step before a newsletter goes out (ADR 018 rule 5): what will be sent, to which
     list, to how many and in which languages, then send, a test to oneself, or back. A plain form;
     works without JavaScript. The three actions stand in one group that wraps whole buttons
     (skill ui-action-layout); send comes first, as the reason the page exists. When nothing can be
     sent, the page says why and offers only the way back. -->
<script lang="ts">
  import { Actions, Button, MetaList, Notice } from '#lib/admin/ui/index.js';
  import { languageName } from '#lib/admin/format.js';
  import { fill, plural, ui } from '../../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const title = $derived(data.item.title || t('admin.content.untitled'));
  const outcome = $derived(data.newsletter?.outcome ?? null);
  const send = $derived(data.send);
</script>

<svelte:head>
  <title>{fill(t('admin.email.send.title'), { title })} · {t('admin.title')}</title>
</svelte:head>

<main class="page admin email-send">
  <h1>{fill(t('admin.email.send.title'), { title })}</h1>
  <p><a href={data.edit}>{t('admin.email.preview.back')}</a></p>
  {#if outcome}
    <Notice tone={outcome.ok ? 'success' : 'error'}><p>{t(outcome.copy)}</p></Notice>
  {/if}
  {#if send.ok}
    <p>{t('admin.email.send.hint')}</p>
    <MetaList
      items={[
        { term: t('admin.email.field.list'), value: data.listLabel },
        {
          term: t('admin.email.send.recipients'),
          value: send.recipients.toLocaleString(data.locale),
        },
        {
          term: t('admin.email.send.locales'),
          value: send.locales.map((l) => languageName(l.locale)).join(', '),
        },
        ...send.locales.map((l) => ({
          term: fill(t('admin.email.send.subject'), { language: languageName(l.locale) }),
          value: l.subject,
        })),
      ]}
    />
    {#if data.recipientsHref}
      <p><a href={data.recipientsHref}>{t('admin.email.send.recipientsLink')}</a></p>
    {/if}
    <form method="post" action="?/send&locale={encodeURIComponent(data.work)}">
      {#each send.locales as l (l.locale)}
        <input type="hidden" name="locales" value={l.locale} />
      {/each}
      <Actions>
        <Button type="submit">{plural(t, 'admin.email.send', send.recipients)}</Button>
        <Button
          type="submit"
          variant="secondary"
          formaction="?/test&locale={encodeURIComponent(data.work)}&back=send"
          >{t('admin.email.test')}</Button
        >
        <Button variant="secondary" href={data.edit}>{t('admin.email.send.cancel')}</Button>
      </Actions>
    </form>
  {:else if data.blocked}
    <Notice tone="warning"><p>{t(data.blocked)}</p></Notice>
  {/if}
</main>
