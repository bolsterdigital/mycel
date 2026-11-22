<!-- The site footer (docs/architecture/content-layout.md § Site chrome), from the same
     `chromeModel` as the header; the credit is decided there (ADR 015 rule 5). One row of columns
     (MY-273): the site's own text, the placed menus, each its own list under its title with every
     group open, and the site's social profiles as icons. Under a rule the small print: the legal
     menu, the consent link a tag manager needs (docs/reference/integrations.md § Consent) and the
     credit. The legal menu is a landmark of its own, so the small print can sit under the rule
     without the column menus. -->
<script lang="ts">
  import { ui } from '../../i18n/index.js';
  import MycelCredit from './MycelCredit.svelte';
  import NavTree from './NavTree.svelte';
  import { SOCIAL_ICONS } from './social-icons.js';
  import type { ChromeLink, ChromeModel } from './chrome.js';

  let {
    chrome,
    credit,
    locale,
    current = null,
    consentHref = null,
  }: {
    chrome: ChromeModel;
    credit: ChromeLink | null;
    locale: string;
    current?: string | null;
    consentHref?: string | null;
  } = $props();
  const t = $derived(ui(locale));
</script>

<footer class="site-footer">
  {#if chrome.footer || chrome.columns.length || chrome.social.length}
    <div class="site-footer-main">
      {#if chrome.footer}<p class="site-footer-about">{chrome.footer}</p>{/if}
      {#if chrome.columns.length}
        <nav class="site-footer-columns" aria-label={t('public.footerNavigation')}>
          {#each chrome.columns as column, c (c)}
            <div class="site-footer-column">
              {#if column.title}<h2 class="site-footer-title">{column.title}</h2>{/if}
              <NavTree nodes={column.nodes} {current} openGroups />
            </div>
          {/each}
        </nav>
      {/if}
      {#if chrome.social.length}
        <div class="site-footer-column site-footer-social">
          <h2 class="site-footer-title">{t('public.social.title')}</h2>
          <ul class="site-social">
            {#each chrome.social as profile (profile.network)}
              {@const icon = SOCIAL_ICONS[profile.network]}
              <li>
                <a href={profile.href} rel="me">
                  <svg
                    viewBox="0 0 24 24"
                    width="20"
                    height="20"
                    aria-hidden="true"
                    focusable="false"
                    class:site-social-stroke={icon.stroke}><path d={icon.d} /></svg
                  ><span class="site-social-name">{profile.label}</span>
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {/if}
  {#if chrome.legal.length || consentHref || credit}
    <div class="site-footer-small">
      {#if chrome.legal.length}
        <nav class="site-footer-legal" aria-label={t('public.legalNavigation')}>
          <NavTree nodes={chrome.legal} {current} openGroups />
        </nav>
      {/if}
      {#if consentHref}<p class="site-footer-consent">
          <a href={consentHref}>{t('consent.footer')}</a>
        </p>{/if}
      {#if credit}<MycelCredit {...credit} />{/if}
    </div>
  {/if}
</footer>
