// The admin's shared components and page patterns (brief #56 § A, § B): every admin screen is
// built from these, on the tokens of theme/admin.css and the styles of ui.css. One import path
// keeps screens from reaching into single files, so a component can be split or renamed here
// without touching them. The files sit in groups (page, nav, form, feedback, display; #94) so a
// new component lands next to its kind instead of at the bottom of one flat list.
export { default as Actions } from './display/Actions.svelte';
export { default as Badge } from './feedback/Badge.svelte';
export { default as BlockCard } from './display/BlockCard.svelte';
export { default as BlockImage } from './display/BlockImage.svelte';
export { default as BlockSummary } from './display/BlockSummary.svelte';
export { default as BlockText } from './display/BlockText.svelte';
export { default as Breadcrumb } from './page/Breadcrumb.svelte';
export { default as Button } from './display/Button.svelte';
export { default as Card } from './display/Card.svelte';
export { default as CardGrid } from './display/CardGrid.svelte';
export { default as Checkbox } from './form/Checkbox.svelte';
export { default as Choices } from './form/Choices.svelte';
export { default as ColorField } from './form/ColorField.svelte';
export { default as RolePicker } from './form/RolePicker.svelte';
export { default as ConfirmAction } from './feedback/ConfirmAction.svelte';
export { default as CopyField } from './form/CopyField.svelte';
export { default as DetailPage } from './page/DetailPage.svelte';
export { default as DocumentOutline } from './nav/DocumentOutline.svelte';
export { default as DashboardWidget } from './display/DashboardWidget.svelte';
export { default as Dialog } from './feedback/Dialog.svelte';
export { default as EditPage } from './page/EditPage.svelte';
export { default as EmptyState } from './feedback/EmptyState.svelte';
export { default as Field } from './form/Field.svelte';
export { default as HintButton } from './feedback/HintButton.svelte';
export { default as Fieldset } from './form/Fieldset.svelte';
export { default as FileDrop } from './form/FileDrop.svelte';
export { default as FormPage } from './page/FormPage.svelte';
export { default as Icon } from './Icon.svelte';
export { default as IconSprite } from './IconSprite.svelte';
export { default as ItemBar } from './page/ItemBar.svelte';
export { default as KeyReveal } from './form/KeyReveal.svelte';
export { default as LocaleSwitch } from './nav/LocaleSwitch.svelte';
export { default as MediaPicker } from './form/MediaPicker.svelte';
export { default as MetaList } from './display/MetaList.svelte';
export { default as NavGroup } from './nav/NavGroup.svelte';
export { default as Notice } from './feedback/Notice.svelte';
export { default as OverviewPage } from './page/OverviewPage.svelte';
export { default as PageHeader } from './page/PageHeader.svelte';
export { default as Pagination } from './nav/Pagination.svelte';
export { default as Panel } from './display/Panel.svelte';
export { default as Select } from './form/Select.svelte';
export { default as SettingsPage } from './page/SettingsPage.svelte';
export { default as SettingsSection } from './page/SettingsSection.svelte';
export { default as Section } from './page/Section.svelte';
export { default as StatusCard } from './display/StatusCard.svelte';
export { default as StatusSummary } from './feedback/StatusSummary.svelte';
export { default as StatusLine } from './feedback/StatusLine.svelte';
export { default as SubNav } from './nav/SubNav.svelte';
export { default as SystemState } from './feedback/SystemState.svelte';
export { default as Table } from './display/Table.svelte';
export { default as Tabs } from './nav/Tabs.svelte';
export { default as ViewSwitch } from './nav/ViewSwitch.svelte';
export { ICONS, type IconName } from './icons.js';
