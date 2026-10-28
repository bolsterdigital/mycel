<!-- Facts about one thing as a definition list: term beside value when the list is wide enough,
     term above value otherwise, so a long filename never squeezes a column (WCAG 1.4.10). -->
<script lang="ts">
  let { items }: { items: readonly { term: string; value: string; href?: string | undefined }[] } =
    $props();
</script>

<div class="ui-meta-host">
  <dl class="ui-meta">
    {#each items as item, i (i)}
      <div>
        <dt>{item.term}</dt>
        <dd>
          {#if item.href}<a href={item.href}>{item.value}</a>{:else}{item.value}{/if}
        </dd>
      </div>
    {/each}
  </dl>
</div>
