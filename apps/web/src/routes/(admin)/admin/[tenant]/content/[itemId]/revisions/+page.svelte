<!-- The revisions of one item (TODO #11 A1): newest first with who and when, a preview link per
     revision (new tab, the default locale), and a GET form that compares two revisions. -->
<script lang="ts">
  import Diff from '#lib/admin/Diff.svelte';
  import Header from '#lib/admin/Header.svelte';
  import { fill, ui } from '../../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const title = $derived(data.item.title || t('admin.content.untitled'));
  const label = (r: { when: string; who: string }) => fill(t('admin.content.revisions.by'), r);
  const from = $derived(data.compare.from || data.revisions[1]?.id || '');
  const to = $derived(data.compare.to || data.revisions[0]?.id || '');
</script>

<svelte:head>
  <title>{t('admin.content.revisions')} · {title} · {t('admin.title')}</title>
</svelte:head>

<Header locale={data.locale} email={data.email} />
<main class="page admin">
  <h1>{fill(t('admin.content.revisions.title'), { title })}</h1>
  <p><a href="{base}/content/{data.item.id}">{t('admin.content.revisions.back')}</a></p>

  {#if data.revisions.length > 1}
    <form method="get" class="card">
      <h2>{t('admin.content.revisions.compare')}</h2>
      {#each [['from', from], ['to', to]] as [name, selected] (name)}
        <div class="field">
          <label for="compare-{name}"
            >{t(
              name === 'from' ? 'admin.content.revisions.from' : 'admin.content.revisions.to'
            )}</label
          >
          <select id="compare-{name}" {name}>
            {#each data.revisions as r (r.id)}
              <option value={r.id} selected={r.id === selected}>{label(r)}</option>
            {/each}
          </select>
        </div>
      {/each}
      <div class="actions">
        <button type="submit">{t('admin.content.revisions.compare')}</button>
      </div>
    </form>
  {/if}

  {#if data.diff}
    <section aria-labelledby="diff">
      <h2 id="diff">{t('admin.content.revisions.changes')}</h2>
      <Diff rows={data.diff} locale={data.locale} />
    </section>
  {/if}

  <section aria-labelledby="list">
    <h2 id="list">{t('admin.content.revisions')}</h2>
    <ol class="revisions">
      {#each data.revisions as r (r.id)}
        <li>
          {label(r)}{#if r.id === data.item.latest}
            ({t('admin.content.revisions.latest')}){/if}
          ·
          <a
            href="{base}/preview/item/{data.item.id}?revision={r.id}&locale={data.item
              .defaultLocale}"
            target="_blank">{t('admin.content.revisions.preview')}</a
          >
        </li>
      {/each}
    </ol>
    {#if data.next}
      <p><a href="?after={data.next}">{t('admin.content.more')}</a></p>
    {/if}
  </section>
</main>
