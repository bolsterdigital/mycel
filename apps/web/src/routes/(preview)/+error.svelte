<!-- A preview route that refuses or fails shows the admin's error page, with the admin's styles:
     the preview itself carries only the site's. -->
<script lang="ts">
  import '#lib/theme/base.css';
  import '#lib/theme/admin.css';
  import '#lib/admin/ui/ui.css';
  import AdminError from '../(admin)/+error.svelte';
</script>

<svelte:head>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminError />
