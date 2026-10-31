<!-- The content list (TODO #11 A1, brief #56 § C2) on the overview pattern: pages and articles
     are separate menu items (editor trial 2026-10-28), one table row per item in the content
     locale (#66 PR 4): its title, one status badge, and the other locales as codes with a dot
     where the translation is behind or missing; the new item as the screen's primary action. Links only, no actions to post, so it works without
     JavaScript; the table scrolls inside its own region on a narrow screen, never the page. The
     page title is the one visible heading (#87); "updated" is relative in the operator's zone,
     the full moment in its title. -->
<script lang="ts">
  import { Badge, Button, Notice, OverviewPage, Table } from '#lib/admin/ui/index.js';
  import { formatWhen } from '#lib/admin/format.js';
  import { ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/content`);
  const status = (s: string) => t(`admin.content.status.${s}` as UiKey);
  const TONE = {
    draft: 'neutral',
    scheduled: 'info',
    published: 'success',
    unpublished: 'warning',
    changed: 'warning',
    missing: 'neutral',
  } as const;
  const tone = (s: string) => TONE[s as keyof typeof TONE] ?? 'neutral';
  // The admin renders on the server only (csr = false), so `now` is the moment of the request.
  const now = new Date();
  const when = (iso: string) =>
    formatWhen(iso, {
      locale: data.locale,
      zone: data.timeZone,
      now,
      relative: data.dateFormat !== 'absolute',
    });
  const kind = $derived(
    t(data.type === 'page' ? 'admin.content.filter.page' : 'admin.content.filter.article')
  );
</script>

<svelte:head>
  <title>{kind} · {data.tenant.name} · {t('admin.title')}</title>
</svelte:head>

<OverviewPage
  title={kind}
  locale={data.locale}
  breadcrumb={[{ label: data.tenant.name, href: `/admin/${data.tenant.slug}` }, { label: kind }]}
  listTitle={kind}
  empty={data.items.length === 0 ? { title: t('admin.content.empty') } : undefined}
  paging={data.next ? { next: `${base}?type=${data.type}&after=${data.next}` } : undefined}
>
  {#snippet notices()}
    {#if form}<Notice tone="error"><p>{t(form.error)}</p></Notice>{/if}
  {/snippet}
  {#snippet actions()}
    <form method="POST" action="?/create">
      <input type="hidden" name="type" value={data.type} /><Button
        >{t(`admin.content.new.${data.type}`)}</Button
      >
    </form>
  {/snippet}

  <Table
    id="content-table"
    caption={kind}
    hideCaption
    columns={[
      { key: 'title', label: t('admin.content.field.title') },
      { key: 'status', label: t('admin.content.state') },
      { key: 'slug', label: t('admin.content.slug') },
      { key: 'updated', label: t('admin.content.column.updated') },
    ]}
  >
    {#snippet rows()}
      {#each data.items as item (item.id)}
        {@const updated = when(item.updated)}
        <tr>
          <th scope="row"
            ><a
              href="{base}/{item.id}"
              lang={item.titleLocale && item.titleLocale !== data.workLocale
                ? item.titleLocale
                : undefined}>{item.title || t('admin.content.untitled')}</a
            ></th
          >
          <td>
            <Badge tone={tone(item.status)}>{status(item.status)}</Badge>
            {#if item.others.length}
              <ul class="ui-locale-codes">
                {#each item.others as o (o.locale)}
                  <li>
                    {o.locale}{#if o.state !== 'ok'}<span
                        class="ui-locale-dot {o.state}"
                        aria-hidden="true"
                      ></span><span class="ui-visually-hidden"
                        >{' '}({t(`admin.locale.state.${o.state}` as UiKey)})</span
                      >{/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </td>
          <td>/{item.slug}</td>
          <td><time datetime={updated.iso} title={updated.full}>{updated.text}</time></td>
        </tr>
      {/each}
    {/snippet}
  </Table>
</OverviewPage>
