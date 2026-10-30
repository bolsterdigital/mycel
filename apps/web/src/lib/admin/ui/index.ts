// The admin's shared components and page patterns (brief #56 § A, § B): every admin screen is
// built from these, on the tokens of theme/admin.css and the styles of ui.css. One import path
// keeps screens from reaching into single files, so a component can be split or renamed here
// without touching them.
export { default as Actions } from './Actions.svelte';
export { default as Badge } from './Badge.svelte';
export { default as Breadcrumb } from './Breadcrumb.svelte';
export { default as Button } from './Button.svelte';
export { default as Card } from './Card.svelte';
export { default as CardGrid } from './CardGrid.svelte';
export { default as Checkbox } from './Checkbox.svelte';
export { default as Choices } from './Choices.svelte';
export { default as ConfirmAction } from './ConfirmAction.svelte';
export { default as DetailPage } from './DetailPage.svelte';
export { default as DashboardWidget } from './DashboardWidget.svelte';
export { default as Dialog } from './Dialog.svelte';
export { default as EditPage } from './EditPage.svelte';
export { default as EmptyState } from './EmptyState.svelte';
export { default as Field } from './Field.svelte';
export { default as Fieldset } from './Fieldset.svelte';
export { default as FileDrop } from './FileDrop.svelte';
export { default as FormPage } from './FormPage.svelte';
export { default as Icon } from './Icon.svelte';
export { default as IconSprite } from './IconSprite.svelte';
export { default as KeyReveal } from './KeyReveal.svelte';
export { default as MediaPicker } from './MediaPicker.svelte';
export { default as MetaList } from './MetaList.svelte';
export { default as NavGroup } from './NavGroup.svelte';
export { default as Notice } from './Notice.svelte';
export { default as OverviewPage } from './OverviewPage.svelte';
export { default as PageHeader } from './PageHeader.svelte';
export { default as Pagination } from './Pagination.svelte';
export { default as Panel } from './Panel.svelte';
export { default as Select } from './Select.svelte';
export { default as SettingsPage } from './SettingsPage.svelte';
export { default as SettingsSection } from './SettingsSection.svelte';
export { default as SubNav } from './SubNav.svelte';
export { default as SystemState } from './SystemState.svelte';
export { default as Table } from './Table.svelte';
export { default as Tabs } from './Tabs.svelte';
export { default as ViewSwitch } from './ViewSwitch.svelte';
export { ICONS, type IconName } from './icons.js';
