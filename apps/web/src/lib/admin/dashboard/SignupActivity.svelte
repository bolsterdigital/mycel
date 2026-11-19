<!-- The dashboard's "Sign-ups" widget (MY-259 PR 1): how many people joined a list and took part
     in a campaign in the last 30 days, against the 30 before, a bar per day, and per list and per
     campaign a link to where the number can be checked. The bars are an SVG drawn with
     attributes, not inline styles (the admin CSP has no `unsafe-inline`), hidden from assistive
     technology; a visually hidden list carries the same numbers per day, and wraps word by word,
     so nothing in it reaches past a 320 px screen. Rejected: a chart library (JavaScript for 30
     rectangles, and the admin renders on the server only), the numbers per day as visible text
     (thirty lines in a widget) and a hidden table (a table keeps its own width behind the clip).
     -->
<script lang="ts">
  import { pickAny, type SupporterActivity } from '@mycel/core';
  import { fill, plural, ui } from '../../../i18n/index.js';

  let {
    activity,
    base,
    locale,
    contentLocale,
  }: {
    activity: SupporterActivity;
    base: string;
    locale: string;
    /** The language titles are shown in, as in the dashboard's content widgets. */
    contentLocale: string;
  } = $props();

  const t = $derived(ui(locale));
  const number = $derived(new Intl.NumberFormat(locale));
  const dayLabel = $derived(
    new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })
  );
  const totals = $derived(activity.days.map((d) => d.joined + d.participations));
  const peak = $derived(Math.max(1, ...totals));
  const quiet = $derived(
    activity.joined + activity.participations + activity.joinedBefore === 0 &&
      activity.participationsBefore === 0 &&
      activity.left === 0
  );
  /** Bar geometry in the SVG's own units: 30 bars of 8 with a gap of 2, 48 high. */
  const HEIGHT = 48;
  const height = (n: number) => (n ? Math.max(2, Math.round((n / peak) * HEIGHT)) : 0);
  const before = (n: number) => fill(t('admin.activity.before'), { n: number.format(n) });
  /** "+24 · 4 left · 28 members": one string, so no template whitespace decides the spacing. */
  const listFacts = (row: SupporterActivity['lists'][number]) =>
    [
      `+${number.format(row.joined)}`,
      row.left ? fill(t('admin.activity.left'), { n: number.format(row.left) }) : null,
      plural(t, 'admin.activity.members', row.members, { n: number.format(row.members) }),
    ]
      .filter(Boolean)
      .join(' · ');
  const campaignTitle = (title: Record<string, string> | null) =>
    (title && pickAny(title, contentLocale)) || t('admin.content.untitled');
</script>

<p class="period">{t('admin.activity.period')}</p>
{#if quiet}
  <p class="ui-widget-later">{t('admin.activity.none')}</p>
{:else}
  <dl class="totals">
    <div>
      <dt>{t('admin.activity.joined')}</dt>
      <dd>
        <span class="total">{number.format(activity.joined)}</span>
        <span class="muted">{before(activity.joinedBefore)}</span>
      </dd>
    </div>
    <div>
      <dt>{t('admin.activity.participations')}</dt>
      <dd>
        <span class="total">{number.format(activity.participations)}</span>
        <span class="muted">{before(activity.participationsBefore)}</span>
      </dd>
    </div>
  </dl>
  <svg
    class="bars"
    viewBox="0 0 298 {HEIGHT}"
    preserveAspectRatio="none"
    aria-hidden="true"
    focusable="false"
  >
    {#each totals as n, i (i)}
      {#if n}<rect x={i * 10} y={HEIGHT - height(n)} width="8" height={height(n)} />{/if}
    {/each}
    <line x1="0" y1={HEIGHT - 0.5} x2="298" y2={HEIGHT - 0.5} />
  </svg>
  <ul class="ui-visually-hidden days" aria-label={t('admin.activity.days')}>
    {#each activity.days as d (d.date)}
      <li>
        {dayLabel.format(new Date(`${d.date}T12:00:00Z`))}: {t('admin.activity.joined')}
        {number.format(d.joined)}, {t('admin.activity.participations')}
        {number.format(d.participations)}
      </li>
    {/each}
  </ul>
  {#if activity.lists.length}
    <h3 class="sub">{t('admin.activity.lists')}</h3>
    <ul class="ui-widget-list">
      {#each activity.lists.slice(0, 5) as row (row.list)}
        <li>
          <a href="{base}/supporters?list={encodeURIComponent(row.list)}">{row.list}</a>
          <span class="muted">{listFacts(row)}</span>
        </li>
      {/each}
    </ul>
  {/if}
  {#if activity.campaigns.length}
    <h3 class="sub">{t('admin.activity.campaigns')}</h3>
    <ul class="ui-widget-list">
      {#each activity.campaigns.slice(0, 5) as row (row.id)}
        <li>
          <a href="{base}/campaigns/{row.id}">{campaignTitle(row.title)}</a>
          <span class="muted"
            >{number.format(row.participations)} ({before(row.participationsBefore)})</span
          >
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .period,
  .muted {
    margin: 0;
    color: var(--color-muted-fg);
  }
  .totals {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    margin: 0;
  }
  .totals dt {
    color: var(--color-muted-fg);
  }
  .totals dd {
    display: grid;
    margin: 0;
  }
  .total {
    font-size: var(--step-2);
    font-weight: 700;
    line-height: 1.1;
  }
  .bars {
    width: 100%;
    height: 3rem;
  }
  .bars rect {
    fill: var(--color-primary-bg);
  }
  .bars line {
    stroke: var(--color-border-strong);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  /* The hidden list wraps, so no line in it is wider than a word. */
  .days {
    white-space: normal;
  }
  .sub {
    margin: 0;
    font-size: var(--step-0);
  }
  @media (forced-colors: active) {
    .bars rect {
      fill: CanvasText;
    }
    .bars line {
      stroke: CanvasText;
    }
  }
</style>
