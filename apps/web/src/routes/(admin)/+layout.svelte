<script lang="ts">
  import '#lib/theme/base.css';
  import '#lib/theme/admin.css';
  import '#lib/admin/ui/ui.css';
  import '#lib/admin/ui/nav/tabs.css';
  import '#lib/admin/ui/writing-sheet.css';
  import '#lib/admin/ui/row-actions.css';
  import '#lib/admin/ui/row-editor.css';
  import '#lib/admin/ui/target-picker.css';
  import '#lib/admin/ui/color-field.css';
  import icon from '#lib/assets/mycel-icon.svg';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();
</script>

<svelte:head>
  <meta name="robots" content="noindex,nofollow" />
  <link rel="icon" href={icon} type="image/svg+xml" />
</svelte:head>

{@render children()}
