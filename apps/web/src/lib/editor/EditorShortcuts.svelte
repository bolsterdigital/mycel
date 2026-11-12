<!-- The edit screen's keyboard shortcuts, folded away in the side column. Every key here is the
     screen's script (`data-shortcuts`); without it the panel stays hidden. A file of its own so
     the edit route does not grow past its ceiling (scripts/gates/file-size.test.mjs). -->
<script lang="ts">
  import { ui } from '../../i18n/index.js';

  let { locale }: { locale: string } = $props();
  const t = $derived(ui(locale));
</script>

<details class="ui-fold item-shortcuts" data-shortcuts>
  <summary>{t('admin.content.keys.title')}</summary>
  <dl>
    <dt><kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>⌘</kbd>+<kbd>S</kbd></dt>
    <dd>{t('admin.content.keys.save')}</dd>
    <dt><kbd>Esc</kbd></dt>
    <dd>{t('admin.content.keys.escape')}</dd>
    <dt><kbd>Enter</kbd></dt>
    <dd>{t('admin.content.keys.search')}</dd>
    <dt><kbd>?</kbd></dt>
    <dd>{t('admin.content.keys.open')}</dd>
  </dl>
</details>

<style>
  .item-shortcuts dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-1) var(--space-3);
    margin: var(--space-2) 0 0;
  }
  .item-shortcuts dd {
    margin: 0;
  }
</style>
