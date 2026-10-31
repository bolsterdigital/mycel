<!-- Choosing what a member or API key may do by role (#101): one radio per role with a line of
     plain explanation, and under "Advanced" the separate capabilities as checkboxes. The form
     posts `role` and `capabilities`; the route reads the checkboxes only when the role is
     `custom` (lib/server/admin/roles.ts), so without JavaScript the radio decides and the ticks
     never silently override it. An existing set that matches no role opens on Custom with the
     advanced part open. Rejected: the checkboxes alone (a list of technical scopes, no abstraction between them and the person) and
     a fourth stored role (a role is derived from the set, never stored; core operators/roles.ts). -->
<script lang="ts">
  import type { Role } from '@mycel/core';
  import { ui, type UiKey } from '../../../../i18n/index.js';
  import Choices from './Choices.svelte';

  let {
    id,
    locale,
    roles,
    capabilities,
    role = undefined,
    selected = [],
  }: {
    id: string;
    locale: string;
    /** The roles on offer, `custom` last; a key never gets `admin`. */
    roles: readonly Role[];
    /** Every capability the advanced part may tick. */
    capabilities: readonly string[];
    /** The current role, if any (a new member starts without one). */
    role?: Role | undefined;
    /** The current capability set, ticked in the advanced part. */
    selected?: readonly string[];
  } = $props();

  const t = $derived(ui(locale));
  const roleOptions = $derived(
    roles.map((r) => ({ value: r, label: t(`admin.role.${r}` as UiKey) }))
  );
  const parts = (capability: string) => capability.split(':');
</script>

{#snippet roleLabel(option: { value: string; label: string })}
  <span class="ui-role">
    <span>{option.label}</span>
    <span class="ui-hint">{t(`admin.role.${option.value}.about` as UiKey)}</span>
  </span>
{/snippet}
{#snippet capabilityLabel(option: { value: string })}
  {parts(option.value)[0]}:<wbr />{parts(option.value)[1]}
{/snippet}

<Choices
  id="{id}-role"
  name="role"
  legend={t('admin.role.legend')}
  {locale}
  required
  options={roleOptions}
  selected={role ? [role] : []}
  optionLabel={roleLabel}
/>
<details class="ui-fold" open={role === 'custom'}>
  <summary>{t('admin.role.advanced')}</summary>
  <p class="ui-hint">{t('admin.role.advanced.hint')}</p>
  <Choices
    id="{id}-capabilities"
    name="capabilities"
    type="checkbox"
    legend={t('admin.invite.capabilities')}
    {locale}
    options={capabilities.map((c) => ({ value: c, label: c }))}
    {selected}
    optionLabel={capabilityLabel}
  />
</details>
