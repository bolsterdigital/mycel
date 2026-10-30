<!-- The content locale switch (#66 PR 4, brief edit-screen § 9 point 4): one button per locale of
     the site, the current one pressed, and a dot after a locale whose translation is behind or
     missing; the dot's meaning is also text for a screen reader and the button's title, so the
     colour never carries it alone (WCAG 1.4.1). The buttons submit the form the caller places them
     in, or the one `form` names: the shell posts the choice, the item's bar saves first and then
     switches. Rejected: a <select> (it needs a script or a second button to apply, and hides the
     state of the other locales) and links (a switch on the edit screen must save what was typed). -->
<script lang="ts">
  import Icon from '../Icon.svelte';
  import { ui } from '../../../../i18n/index.js';

  type State = 'ok' | 'behind' | 'missing';
  let {
    label,
    locales,
    name = 'to',
    form,
    formaction,
    locale,
  }: {
    /** The group's accessible name ("Language of the content"). */
    label: string;
    locales: readonly { locale: string; state: State; current: boolean }[];
    name?: string;
    /** The id of the form the buttons submit, when they stand outside it. */
    form?: string | undefined;
    formaction?: string | undefined;
    /** The admin's own locale, for the words of the states. */
    locale: string;
  } = $props();
  const t = $derived(ui(locale));
  const words = (s: State) =>
    s === 'behind'
      ? t('admin.locale.state.behind')
      : s === 'missing'
        ? t('admin.locale.state.missing')
        : '';
</script>

<div class="ui-locale-switch" role="group" aria-label={label}>
  <Icon name="languages" />
  {#each locales as l (l.locale)}
    <button
      type="submit"
      class="ui-locale-switch-option"
      {name}
      value={l.locale}
      {form}
      {formaction}
      aria-pressed={l.current ? 'true' : 'false'}
      title={l.state === 'ok' ? undefined : words(l.state)}
      ><span class="ui-locale-switch-code">{l.locale}</span>{#if l.state !== 'ok'}<span
          class="ui-locale-dot {l.state}"
          aria-hidden="true"
        ></span><span class="ui-visually-hidden">({words(l.state)})</span>{/if}</button
    >
  {/each}
</div>
