<!-- One action: a link when it navigates, a button when it posts (ADR 009, native first). Every
     variant reaches 44 CSS px and wraps its label at word boundaries, never clipped (skill
     ui-action-layout). `link` looks like text but keeps the button's target size. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

  type Variant = 'primary' | 'secondary' | 'danger' | 'link';
  type Props = { variant?: Variant; children: Snippet } & (
    | ({ href: string } & Omit<HTMLAnchorAttributes, 'href' | 'children'>)
    | ({ href?: undefined } & Omit<HTMLButtonAttributes, 'children'>)
  );

  let { variant = 'primary', children, class: extra = '', ...rest }: Props = $props();
  const css = $derived(['ui-button', variant, extra].filter(Boolean).join(' '));
</script>

{#if rest.href !== undefined}
  <a class={css} {...rest as HTMLAnchorAttributes}>{@render children()}</a>
{:else}
  <button class={css} type="submit" {...rest as HTMLButtonAttributes}>{@render children()}</button>
{/if}
