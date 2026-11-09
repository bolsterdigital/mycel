<!-- One live status for movement, outside the cards the article writer portals. The native
     cards stay silent without JavaScript; a second status per card would repeat announcements. -->
<script lang="ts">
  import type { UiKey } from '../../../i18n/index.js';
  import './block-move.css';
  let { t }: { t: (key: UiKey) => string } = $props();
</script>

<span
  class="ui-visually-hidden"
  aria-live="polite"
  data-block-move-status
  data-before={t('admin.block.move.before')}
  data-after={t('admin.block.move.after')}
  data-picked={t('admin.block.move.picked')}
  data-cancelled={t('admin.block.move.cancelled')}
></span>
