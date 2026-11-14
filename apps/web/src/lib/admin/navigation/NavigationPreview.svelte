<!-- The navigation of one revision in one locale as visitors would get it, per placement: the
     main navigation with what stands in the bar, the action buttons in priority order, the footer
     columns with their titles and the legal links. Each item shows its text and the path it
     leads to on the site, as text: following it from the admin would leave the editor. A
     structured list, not the public header and footer, which are a later step (ADR 036 rule 7:
     the preview shows published targets only). -->
<script lang="ts">
  import '#lib/admin/navigation/menu-list.css';
  import { Badge, Section } from '#lib/admin/ui/index.js';
  import type { Preview, PreviewItem, PreviewPlacement } from './preview.js';
  import { fill, ui } from '../../../i18n/index.js';

  let {
    id,
    preview,
    menus,
    locale,
  }: {
    /** Prefix of the section ids, so a page can hold more than one preview. */
    id: string;
    preview: Preview;
    /** Menu names by id. */
    menus: Record<string, string>;
    /** The admin's locale, for the copy. */
    locale: string;
  } = $props();
  const t = $derived(ui(locale));
  const name = (item: PreviewItem) =>
    item.label ??
    (item.system ? t(`admin.navigation.system.${item.system}`) : t('admin.navigation.noLabel'));
  const menu = (p: PreviewPlacement) =>
    fill(t('admin.navigation.preview.menu'), { menu: menus[p.menuId] ?? p.menuId });
</script>

{#snippet card(item: PreviewItem, badge?: string)}
  <div class="ui-menu-item">
    <p class="ui-menu-item-label">
      {name(item)}
      {#if badge}<Badge>{badge}</Badge>{/if}
      {#if item.inBar}<Badge>{t('admin.navigation.preview.bar')}</Badge>{/if}
      {#if !item.href}<Badge>{t('admin.navigation.kind.group')}</Badge>{/if}
    </p>
    {#if item.href}<p class="ui-menu-item-facts">
        {fill(t('admin.navigation.leadsTo'), { target: item.href })}
      </p>{/if}
  </div>
{/snippet}

{#snippet list(items: PreviewItem[], badges: string[] = [])}
  {#if items.length}
    <ol class="ui-menu-list">
      {#each items as item, i (item.id)}
        <li>
          {@render card(item, badges[i])}
          {#if item.children.length}
            <ol aria-label={fill(t('admin.navigation.subItemsOf'), { name: name(item) })}>
              {#each item.children as child (child.id)}<li>{@render card(child)}</li>{/each}
            </ol>
          {/if}
        </li>
      {/each}
    </ol>
  {:else}
    <p>{t('admin.navigation.preview.empty')}</p>
  {/if}
{/snippet}

{#snippet placement(key: string, p: PreviewPlacement | null, badges: string[] = [])}
  <Section
    id="{id}-{key}"
    title={t(`admin.navigation.placement.${key as 'main'}`)}
    intro={p ? menu(p) : undefined}
    {locale}
  >
    {#if p}{@render list(p.items, badges)}{:else}<p>{t('admin.navigation.preview.nothing')}</p>{/if}
  </Section>
{/snippet}

{@render placement('main', preview.main)}
{@render placement('actions', preview.actions, [
  t('admin.navigation.preview.primary'),
  t('admin.navigation.preview.secondary'),
])}
<Section id="{id}-footer" title={t('admin.navigation.placement.footer')} {locale}>
  {#each preview.footer as column, i (i)}
    <section class="ui-menu-column" aria-labelledby="{id}-footer-{i}">
      <h3 id="{id}-footer-{i}">{column.title ?? t('admin.navigation.preview.untitled')}</h3>
      <p class="ui-menu-item-facts">{menu(column)}</p>
      {@render list(column.items)}
    </section>
  {:else}
    <p>{t('admin.navigation.preview.nothing')}</p>
  {/each}
</Section>
{@render placement('legal', preview.legal)}
