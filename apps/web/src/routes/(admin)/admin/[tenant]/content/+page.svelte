<!-- The content list (TODO #11 A1, brief #56 § C2) on the overview pattern: pages and articles
     are separate menu items (proef 4), one table row per item with its status per locale as badges, and the new
     item as the screen's primary action. Links only, no actions to post, so it works without
     JavaScript; the table scrolls inside its own region on a narrow screen, never the page. -->
<script lang="ts">
  import { Badge, Button, OverviewPage, Table } from '#lib/admin/ui/index.js';
  import { ui, type UiKey } from '../../../../../i18n/index.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const t = $derived(ui(data.locale));
  const base = $derived(`/admin/${data.tenant.slug}/content`);
  const status = (s: string) => t(`admin.content.status.${s}` as UiKey);
  const TONE = {
    draft: 'neutral',
    scheduled: 'info',
    published: 'success',
    unpublished: 'warning',
  } as const;
  const tone = (s: string) => TONE[s as keyof typeof TONE] ?? 'neutral';
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
  {#snippet actions()}
    <Button href="{base}/new?type={data.type}">{t(`admin.content.new.${data.type}`)}</Button>
  {/snippet}

  <Table
    id="content-table"
    caption={kind}
    columns={[
      { key: 'title', label: t('admin.content.field.title') },
      { key: 'status', label: t('admin.content.state') },
      { key: 'slug', label: t('admin.content.slug') },
      { key: 'updated', label: t('admin.content.column.updated') },
    ]}
  >
    {#snippet rows()}
      {#each data.items as item (item.id)}
        <tr>
          <th scope="row"
            ><a href="{base}/{item.id}">{item.title || t('admin.content.untitled')}</a></th
          >
          <td>
            <ul class="ui-badges">
              {#each item.publication as p (p.locale)}
                <li>
                  <Badge tone={p.changes ? 'warning' : tone(p.status)}
                    >{p.locale}: {status(p.status)}{#if p.changes}, {t(
                        'admin.content.status.changes'
                      )}{/if}</Badge
                  >
                </li>
              {/each}
            </ul>
          </td>
          <td>/{item.slug}</td>
          <td>{item.updated}</td>
        </tr>
      {/each}
    {/snippet}
  </Table>
</OverviewPage>
