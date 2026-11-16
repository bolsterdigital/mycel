<!-- The old addresses of an item: each forwards to it until an editor removes it (migration 0062).
     One action per row, which wraps under the address when both do not fit (skill
     ui-action-layout); the button posts the surrounding form, which saves first. -->
<script lang="ts">
  import { Button } from '../ui/index.js';
  import { fill, ui } from '../../../i18n/index.js';

  let {
    data,
    action,
  }: {
    /** The edit screen's data: its locale, whether the operator may write, the item's old paths. */
    data: {
      locale: string;
      canWrite: boolean;
      item: { oldPaths: readonly { slug: string; path: string }[] };
    };
    /** The form action of a button, from the edit screen. */
    action: (name: string) => string;
  } = $props();
  const t = $derived(ui(data.locale));
  const paths = $derived(data.item.oldPaths);
</script>

{#if paths.length}
  <section class="old-addresses" aria-labelledby="old-addresses">
    <h3 id="old-addresses">{t('admin.content.slug.old')}</h3>
    <p class="ui-hint">{t('admin.content.slug.oldHint')}</p>
    <ul>
      {#each paths as old (old.slug)}
        <li>
          <code>{old.path}</code>
          {#if data.canWrite}
            <Button
              variant="secondary"
              formaction={action('dropOldAddress')}
              name="oldSlug"
              value={old.slug}>{fill(t('admin.content.slug.oldRemove'), { path: old.path })}</Button
            >
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-3);
    padding-block: var(--space-1);
  }
  code {
    overflow-wrap: anywhere;
  }
</style>
