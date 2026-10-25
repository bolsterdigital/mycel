<!-- The footer credit (ADR 015 rule 5): one visible link, no script, no tracking parameters. On
     unless the tenant is entitled to `remove_branding`; the (public) layout decides, this only
     renders. TODO #8c builds the site chrome around it. -->
<script lang="ts">
  let { href, label }: { href: string; label: string } = $props();
</script>

<div class="mycel-credit">
  <p><a {href} rel="noopener">{label}</a></p>
</div>
