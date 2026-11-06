<!-- Notifications (brief admin-attention-notifications § 3 and 5): what asks for
     attention on this site that this member may act on, one section per source in the order of
     core's sources, each row a sentence that links to where it is solved. A solved problem leaves
     the list by itself; "New" marks what arrived since the member last read it. With something
     new the page has one action, "Mark as read", a native post; with JavaScript the page posts it
     by itself once shown and the button goes (attention-seen.js), so the rows keep saying "New"
     for this visit and the bell is quiet on the next page. Nothing to show is one StatusLine, as
     on the status page. Rejected: one list of all sources newest first (the brief asks a list per
     source, and a reader scans for "my kind" first) and a per-row dismiss (§ 2). -->
<script lang="ts">
  import AdminScript from '#lib/admin/trusted/AdminScript.svelte';
  import AttentionList from '#lib/admin/attention/AttentionList.svelte';
  import { Button, Notice, PageHeader, Section, StatusLine } from '#lib/admin/ui/index.js';
  import { fill, refusalCopy, ui } from '../../../../../i18n/index.js';
  import { AttentionSource } from '@mycel/core';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}`);
  const attention = $derived(typeof data.attention === 'object' ? data.attention : null);
  const failed = $derived(form && 'error' in form ? form : null);
  const done = $derived(form && 'done' in form && form.done ? form : null);
  const unread = $derived(attention?.summary.unread ?? 0);
  const sections = $derived(
    AttentionSource.options
      .map((source) => ({
        source,
        items: attention?.items.filter((i) => i.source === source) ?? [],
      }))
      .filter((s) => s.items.length)
  );
  const count = (n: number) =>
    fill(t(n === 1 ? 'admin.attention.count.one' : 'admin.attention.count.many'), { count: n });
</script>

<svelte:head>
  <title>{t('admin.attention.title')} · {data.tenant.name}</title>
  {#if unread}<AdminScript src="/_admin/attention-seen.js" />{/if}
</svelte:head>

<main class="page admin">
  <PageHeader
    title={t('admin.attention.title')}
    locale={data.locale}
    breadcrumb={[{ label: data.tenant.name, href: base }, { label: t('admin.attention.title') }]}
    description={t('admin.attention.lead')}
  />

  {#if failed}
    <Notice tone="error"><p>{refusalCopy(t, failed)}</p></Notice>
  {:else if done}
    <Notice tone="success"><p>{t('admin.attention.done.seen')}</p></Notice>
  {/if}

  {#if data.attention === null}
    <Notice tone="info" live={false}><p>{t('admin.attention.none.access')}</p></Notice>
  {:else if !attention}
    <Notice tone="warning" live={false}><p>{t('admin.attention.unknown')}</p></Notice>
  {:else}
    {#if unread}
      <form class="ui-attention-read" method="post" action="?/seen" data-attention-seen>
        <input type="hidden" name="at" value={data.shownAt} />
        <p>
          {fill(t(unread === 1 ? 'admin.attention.unread.one' : 'admin.attention.unread.many'), {
            count: unread,
          })}
        </p>
        <Button variant="secondary">{t('admin.attention.markRead')}</Button>
      </form>
    {/if}

    {#if sections.length === 0}
      <StatusLine text={t('admin.attention.none')} />
    {:else}
      {#each sections as section (section.source)}
        <Section
          id="attention-{section.source}"
          title={t(`admin.attention.source.${section.source}` as const)}
          count={count(section.items.length)}
          locale={data.locale}
        >
          <AttentionList
            items={section.items}
            {base}
            locale={data.locale}
            timeZone={data.timeZone}
            relative={data.dateFormat !== 'absolute'}
            rows
          />
        </Section>
      {/each}
    {/if}
  {/if}
</main>
