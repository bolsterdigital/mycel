<!-- The form pattern (brief #56 § B) for a new item or block: one narrow column, the fields in
     groups and save and cancel always in the same place, at the end of the form, save first. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Actions from '../display/Actions.svelte';
  import Button from '../display/Button.svelte';
  import PageHeader from './PageHeader.svelte';

  type Crumb = { label: string; href?: string | undefined };

  let {
    title,
    locale,
    breadcrumb,
    description,
    notices,
    lead,
    action,
    enctype,
    submit,
    cancel,
    children,
  }: {
    title: string;
    locale: string;
    breadcrumb?: readonly Crumb[] | undefined;
    description?: string | undefined;
    notices?: Snippet;
    /** What the page shows before its form (the account and sites of the profile, #101). */
    lead?: Snippet;
    /** The form action; the page itself when absent. */
    action?: string | undefined;
    enctype?: 'multipart/form-data' | undefined;
    submit: string;
    cancel?: { href: string; label: string } | undefined;
    children: Snippet;
  } = $props();
</script>

<main class="page admin ui-form-page">
  <PageHeader {title} {locale} {breadcrumb} {description} />
  {#if notices}{@render notices()}{/if}
  {#if lead}{@render lead()}{/if}
  <form method="post" {action} {enctype}>
    <div class="ui-fields">{@render children()}</div>
    <Actions stack>
      <Button>{submit}</Button>
      {#if cancel}<Button variant="link" href={cancel.href}>{cancel.label}</Button>{/if}
    </Actions>
  </form>
</main>
