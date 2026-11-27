<!-- Both profiles keep their controls while the editor switches. Native radios and :has()
     also switch the visible group before hydration and when the browser has no JavaScript. -->
<script lang="ts">
  import { ARTICLE_OPTIONS, ARTICLE_PROFILES } from '@mycel/core';
  import { Choices } from '#lib/admin/ui/index.js';
  import { ui } from '../../../i18n/index.js';
  let { locale, v, legacy }: { locale: string; v: (key: string) => string; legacy: boolean } =
    $props();
  const t = $derived(ui(locale));
  const keys = Object.keys(ARTICLE_OPTIONS) as (keyof typeof ARTICLE_OPTIONS)[];
  let counts = $state<Partial<Record<string, number>>>({});
  function count(event: Event, profile: string) {
    const group = event.currentTarget as HTMLElement;
    counts[profile] = group.querySelectorAll('input:checked:not([value=""])').length;
  }
</script>

<div class="article-profile-fields">
  <Choices
    id="articleProfile"
    name="articleProfile"
    legend={t('article.profile.label')}
    hint={t('article.profile.hint')}
    {locale}
    selected={[v('articleProfile')]}
    options={[
      ...(legacy ? [{ value: '', label: t('article.profile.keep') }] : []),
      ...ARTICLE_PROFILES.map((value) => ({ value, label: t(`article.profile.${value}`) })),
    ]}
  />
  {#each ARTICLE_PROFILES as profile (profile)}
    <details class={profile} onchange={(e) => count(e, profile)}>
      <summary
        >{t('article.profile.advanced').replace(
          '{count}',
          String(counts[profile] ?? keys.filter((key) => v(`profile.${profile}.${key}`)).length)
        )}</summary
      >
      {#each keys as key (key)}
        {@const name = `profile.${profile}.${key}`}
        <Choices
          id={name}
          {name}
          {locale}
          legend={t(`article.profile.${key}`)}
          selected={[v(name)]}
          options={[
            { value: '', label: t('article.profile.default') },
            ...ARTICLE_OPTIONS[key].map((value) => ({
              value,
              label: t(`article.profile.${value}`),
            })),
          ]}
        />
      {/each}
    </details>
  {/each}
</div>

<style>
  details {
    display: none;
  }
  .article-profile-fields:has(:global(input[name='articleProfile'][value='post']:checked))
    details.post,
  .article-profile-fields:has(:global(input[name='articleProfile'][value='longread']:checked))
    details.longread,
  .article-profile-fields:has(:global(input[name='articleProfile'][value='media']:checked))
    details.media {
    display: block;
  }
  summary {
    padding-block: 0.75rem;
    cursor: pointer;
    min-height: 44px;
  }
  .article-profile-fields :global(.ui-choice label) {
    display: flex;
    align-items: center;
    min-inline-size: 3rem;
    hyphens: none;
    overflow-wrap: normal;
    min-block-size: max(44px, 2.75rem);
  }
</style>
