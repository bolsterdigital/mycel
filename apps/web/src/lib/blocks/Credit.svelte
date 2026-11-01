<script lang="ts">
  import type { MediaCredit } from '@mycel/core';

  let { credit, photographer }: { credit: MediaCredit; photographer: string } = $props();
</script>

<span class="credit"
  >{#if credit.work}{credit.work.title}, {credit.work
      .maker}{/if}{#if credit.work && credit.photographer}
    ·
  {/if}{#if credit.photographer}{photographer.replace(
      '{name}',
      () => credit.photographer ?? ''
    )}{/if}</span
>
