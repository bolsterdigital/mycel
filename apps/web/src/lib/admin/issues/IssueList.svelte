<!-- Readiness and publication issues of the edit page as a list: each names its field, linked
     where the page has one, and says what is wrong. The page words a path (`name`), since that
     needs the document's locales. Rejected: a snippet in the page, which outgrew its ceiling. -->
<script lang="ts">
  import { ui, type UiKey } from '../../../i18n/index.js';

  let {
    list,
    name,
    locale,
  }: {
    list: readonly { path: string; field: string | null; copy: UiKey }[];
    name: (path: string) => string;
    locale: string;
  } = $props();

  const t = $derived(ui(locale));
</script>

<ul>
  {#each list as i (i.path + i.copy)}
    <li>
      {#if i.field}<a href="#{i.field}">{name(i.path)}</a>{:else}{name(i.path)}{/if}: {t(i.copy)}
    </li>
  {/each}
</ul>
