<!-- The admin preview (TODO #11 A1): the site's own stylesheet and nothing of the admin, so the
     page looks as it will on the site. The preview banner is part of the page itself. -->
<script lang="ts">
  import '#lib/theme/base.css';
  import '#lib/theme/preview.css';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();
</script>

{@render children()}
