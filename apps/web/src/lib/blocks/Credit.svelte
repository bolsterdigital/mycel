<!-- Who made an image. Set apart from the caption (P185-79): a line of its own with an icon for
     the kind of image (a camera for a photo, a pen for an illustration, a frame for anything
     else) instead of the word, which stays for a screen reader. The icons are Lucide's (ISC),
     inline: a public page has no icon sprite. Rejected: one generic icon for every kind (a camera
     beside a drawing says something untrue) and showing the word as well (P185-79 chose the icon). -->
<script lang="ts">
  import { creditKind, type CreditKind, type MediaCredit } from '@mycel/core';

  let { credit, words }: { credit: MediaCredit; words: Record<CreditKind, string> } = $props();

  const kind = $derived(creditKind(credit));
  // The copy holds {name} at the place its language wants it: 'Foto: {name}'.
  const parts = $derived(words[kind].split('{name}'));
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
        >{#if kind === 'illustration'}<path
            d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"
          /><path
            d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18"
          /><path d="m2.3 2.3 7.286 7.286" /><circle
            cx="11"
            cy="11"
            r="2"
          />{:else if kind === 'other'}<rect
            width="18"
            height="18"
            x="3"
            y="3"
            rx="2"
            ry="2"
          /><circle cx="9" cy="9" r="2" /><path
            d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"
          />{:else}<path
            d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"
          /><circle cx="12" cy="13" r="3" />{/if}</svg
      >{#if parts[0]}<span class="credit-word">{parts[0]}</span
        >{/if}{credit.photographer}{#if parts[1]}<span class="credit-word">{parts[1]}</span
        >{/if}</span
    >{/if}</span
>
