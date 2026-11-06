<!-- Notifications as rows: per row one sentence that links to where it is solved,
     "New" when it arrived after the member last read the list, and since when it asks. The
     notifications page and the dashboard card render the same rows from the same `attention.list`.
     "New" is a word in the row, not only a colour or a dot (WCAG 1.4.1). Rejected: a table (one
     fact per row, no columns to compare) and a dismiss button per row (a notification leaves by
     itself once the problem is solved; read state is one moment per member, brief § 2). -->
<script lang="ts">
  import type { AttentionItem } from '@mycel/core';
  import { formatWhen } from '../format.js';
  import { Badge } from '../ui/index.js';
  import { ui } from '../../../i18n/index.js';
  import { attentionHref, attentionText } from './words.js';

  let {
    items,
    base,
    locale,
    timeZone,
    relative,
    rows = false,
  }: {
    items: readonly AttentionItem[];
    /** `/admin/<tenant>`. */
    base: string;
    locale: string;
    timeZone: string;
    relative: boolean;
    /** Framed rows, as the status page lists (`ui-rows`); without, the quiet rows of a widget. */
    rows?: boolean;
  } = $props();

  const t = $derived(ui(locale));
  // The admin renders on the server, so `now` is the moment of the request.
  const now = new Date();
</script>

<ul class={['ui-attention-list', rows && 'ui-rows']}>
  {#each items as item (item.key)}
    {@const at = formatWhen(item.since, { locale, zone: timeZone, now, relative })}
    <li
      class={['ui-attention-item', rows && 'ui-row', item.unread && 'unread']}
      data-attention={item.key}
    >
      <a href={attentionHref(base, item)}>{attentionText(t, item)}</a>
      <span class="ui-attention-meta"
        >{#if item.unread}<Badge tone="info">{t('admin.attention.new')}</Badge>{/if}<time
          datetime={at.iso}
          title={at.full}>{at.text}</time
        ></span
      >
    </li>
  {/each}
</ul>
