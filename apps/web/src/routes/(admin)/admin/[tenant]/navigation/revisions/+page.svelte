<!-- The versions of the navigation, newest first, on the overview pattern: when each was saved
     (to its view), and in a few words what is special about it: the current draft, live in which
     languages, merged with a change made at the same time, restored from an older version. A
     plain table of links; restoring happens on the version's own page, after looking at it. -->
<script lang="ts">
  import { formatWhen } from '#lib/admin/format.js';
  import { OverviewPage, Table } from '#lib/admin/ui/index.js';
  import { fill, ui } from '../../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/navigation`);
  const title = $derived(t('admin.navigation.revisions'));
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      relative: data.dateFormat !== 'absolute',
    });
  type Row = (typeof data.revisions)[number];
  const notes = (r: Row) =>
    [
      r.current && t('admin.navigation.revision.current'),
      r.liveIn.length &&
        fill(t('admin.navigation.revision.liveIn'), { locales: r.liveIn.join(', ') }),
      r.merged && t('admin.navigation.revision.merged'),
      r.restored &&
        (r.restored.at
          ? fill(t('admin.navigation.revision.restoredFrom'), { when: when(r.restored.at).text })
          : t('admin.navigation.revision.restored')),
    ]
      .filter(Boolean)
      .join(' · ');
</script>

<svelte:head>
  <title>{title} · {t('admin.navigation.title')} · {data.tenant.name}</title>
</svelte:head>

<OverviewPage
  {title}
  locale={data.locale}
  breadcrumb={[
    { label: data.tenant.name, href: `/admin/${data.tenant.slug}` },
    { label: t('admin.navigation.title'), href: base },
    { label: title },
  ]}
  description={t('admin.navigation.revisions.intro')}
  listTitle={title}
  empty={data.revisions.length
    ? undefined
    : { title: t('admin.navigation.empty'), icon: 'menu', body: t('admin.navigation.empty.body') }}
>
  <Table
    id="revisions"
    caption={title}
    hideCaption
    stack
    card
    level
    columns={[
      { key: 'when', label: t('admin.navigation.column.when') },
      { key: 'notes', label: t('admin.navigation.column.notes') },
    ]}
  >
    {#snippet rows()}
      {#each data.revisions as r (r.id)}
        {@const w = when(r.createdAt)}
        <tr>
          <td data-label={t('admin.navigation.column.when')}
            ><a href="{base}/revisions/{r.id}"
              ><time datetime={w.iso} title={w.full}>{w.text}</time></a
            ></td
          >
          <td data-label={t('admin.navigation.column.notes')}>{notes(r)}</td>
        </tr>
      {/each}
    {/snippet}
  </Table>
</OverviewPage>
