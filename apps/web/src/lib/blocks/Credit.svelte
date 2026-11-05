<!-- Who made an image. Set apart from the caption (P185-79): a line of its own with a camera instead
     of the word, which stays for a screen reader. Whether a credit can also name an illustrator
     is an information-architecture question of its own (TODO). -->
<script lang="ts">
  import type { MediaCredit } from '@mycel/core';

  let { credit, photographer }: { credit: MediaCredit; photographer: string } = $props();

  // The copy holds {name} at the place its language wants it: 'Foto: {name}'.
  const parts = $derived(photographer.split('{name}'));
</script>

<span class="credit"
  >{#if credit.work}{credit.work.title}, {credit.work
      .maker}{/if}{#if credit.work && credit.photographer}
    ·
  {/if}{#if credit.photographer}<span class="credit-by"
      ><svg
        class="credit-icon"
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        ><path
          d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"
        /><circle cx="12" cy="13" r="3" /></svg
      >{#if parts[0]}<span class="credit-word">{parts[0]}</span
        >{/if}{credit.photographer}{#if parts[1]}<span class="credit-word">{parts[1]}</span
        >{/if}</span
    >{/if}</span
>
